/**
 * radar-renderer.js
 * 使用 WebGL 硬件加速渲染雷达回波
 * 并提供高精度的 CPU 端物理计算接口 (已校准一致性)
 */
import { getElevationAt } from './terrain-data.js';
import { calculateBackgroundHumidity } from './visualization.js';

// ============================================================
// GLSL Fragment Shader (物理核心 - 用于画面渲染)
// ============================================================
const fsSource = `
    // [修改] 强制使用高精度浮点数
    precision highp float;

    // --- Uniforms ---
    uniform vec2 u_resolution;       
    uniform float u_time;            
    uniform vec2 u_radar_center;     
    uniform float u_radar_radius_km; 
    uniform float u_noise_seed;      
    
    // 气旋参数
    uniform int u_has_cyclone;       
    uniform vec2 u_cyc_pos;          
    uniform float u_cyc_size;        
    uniform float u_cyc_intensity;   
    uniform float u_cyc_age;         

    uniform vec4 u_sys_params[20]; 
    uniform float u_sys_strength[20];
    uniform float u_env_humidity;

    uniform int u_sys_count;
    uniform sampler2D u_terrain_map;

    const float PI = 3.14159265359;
    const float DEG_TO_RAD = 0.01745329251;

    // [关键修改] 使用无正弦哈希 (Hash without Sine) 替代 fract(sin(...))
    // 这能确保 GPU 和 CPU (Math.fround) 计算出的随机数完全一致
    // Dave_Hoskins Hash12
    float random(vec2 p) {
        vec2 p2 = p + vec2(u_noise_seed);
        vec3 p3  = fract(vec3(p2.xyx) * .1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    // 噪声函数 (调用新的 random)
    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.y * u.x;
    }

    // 分形布朗运动 (FBM)
    float fbm(vec2 st, int octaves) {
        float value = 0.0;
        float amp = 0.5;
        // 手动展开循环
        value += noise(st) * amp; st *= 2.0; amp *= 0.5;
        value += noise(st) * amp; st *= 2.0; amp *= 0.5;
        if (octaves > 2) {
             value += noise(st) * amp; st *= 2.0; amp *= 0.5;
        }
        return value;
    }
    
    // 颜色映射 (dBZ -> RGBA)
    vec4 getRadarColor(float dbz) {
        if (dbz < 15.0) return vec4(0.0);
        if (dbz < 20.0) return vec4(0.0, 0.65, 0.95, 0.35); // Cyan
        if (dbz < 30.0) return vec4(0.0, 0.85, 0.0, 0.55); // Green
        if (dbz < 40.0) return vec4(0.0, 0.60, 0.0, 0.7);
        if (dbz < 45.0) return vec4(1.0, 1.0, 0.0, 0.8); // Yellow
        if (dbz < 50.0) return vec4(1.0, 0.65, 0.0, 0.9); // Orange
        if (dbz < 55.0) return vec4(1.0, 0.1, 0.1, 0.95);
        if (dbz < 60.0) return vec4(0.9, 0.0, 0.0, 0.95); // Red
        if (dbz < 65.0) return vec4(1.0, 0.0, 0.9, 1.0);
        if (dbz < 70.0) return vec4(0.6, 0.0, 0.2, 1.0);
        return vec4(0.9, 0.9, 1.0, 1.0);                 // Purple
    }

    // ------------------------------------------
    // 物理计算辅助函数 (简化版)
    // ------------------------------------------
    float getElevation(vec2 pos) {
        float u = (pos.x + 180.0) / 360.0;
        float v = (90.0 - pos.y) / 180.0;
        if (u < 0.0) u += 1.0;
        if (u > 1.0) u -= 1.0;
        v = clamp(v, 0.0, 1.0);
        float val = texture2D(u_terrain_map, vec2(u, v)).r;
        const float MAX_ELEVATION = 680.0;
        return val * MAX_ELEVATION;
    }

    float getPressure(vec2 pos) {
        float p = 0.0;
        for (int i = 0; i < 20; i++) {
            if (i >= u_sys_count) break;
            vec4 params = u_sys_params[i];
            float strength = u_sys_strength[i];
            vec2 center = params.xy;
            vec2 sigma = params.zw;
            float dx = pos.x - center.x;
            if (abs(dx) > 180.0) dx = dx > 0.0 ? dx - 360.0 : dx + 360.0;
            float dy = pos.y - center.y;
            float val = strength * exp(-0.5 * ( (dx*dx)/(sigma.x*sigma.x) + (dy*dy)/(sigma.y*sigma.y) ));
            p += val;
        }
        return 1012.0 + p;
    }

    vec2 getWindVector(vec2 pos) {
        float dDeg = 0.5;
        float p_x_plus = getPressure(pos + vec2(dDeg, 0.0));
        float p_x_minus = getPressure(pos - vec2(dDeg, 0.0));
        float p_y_plus = getPressure(pos + vec2(0.0, dDeg));
        float p_y_minus = getPressure(pos - vec2(0.0, dDeg));
        float gradX = p_x_plus - p_x_minus;
        float gradY = p_y_plus - p_y_minus;
        float f_sign = pos.y >= 0.0 ? 1.0 : -1.0;
        float bgScale = 4.0;
        vec2 wind_bg = vec2(-gradY, gradX) * bgScale * f_sign;

        vec2 wind_cyc = vec2(0.0);
        if (u_has_cyclone > 0) {
            vec2 offset_deg = pos - u_cyc_pos;
            float dx_km = offset_deg.x * 111.0 * cos(radians(u_cyc_pos.y));
            float dy_km = offset_deg.y * 111.0;
            float dist = sqrt(dx_km*dx_km + dy_km*dy_km);
            float rmw = 20.0 + u_cyc_size * 0.15;
            float v_tan = 0.0;
            float intensity = u_cyc_intensity * 0.514; 
            if (dist < u_cyc_size * 4.0) {
                if (dist < rmw) {
                    v_tan = intensity * (dist / rmw);
                } else {
                    v_tan = intensity * pow(rmw / dist, 0.6); 
                }
                float angle = atan(dy_km, dx_km);
                float rot = u_cyc_pos.y >= 0.0 ? 1.5708 : -1.5708; 
                float wind_angle = angle + rot;
                wind_cyc = vec2(cos(wind_angle), sin(wind_angle)) * v_tan;
            }
        }
        return wind_bg + wind_cyc;
    }

    void main() {
        vec2 st = gl_FragCoord.xy / u_resolution; 
        vec2 center = vec2(0.5);
        vec2 offset = st - center; 
        float angle_rad = atan(offset.y, offset.x);
        float edge_noise = fbm(vec2(angle_rad * 10.0, u_time * 0.1), 2);
        float max_radius = 0.97 + 0.03 * edge_noise;
        float dist_ratio = length(offset) * 2.0;
        
        if (dist_ratio > max_radius) discard; 

        // 物理距离映射
        float dist_km = dist_ratio * u_radar_radius_km;
        vec2 px_offset_km = offset * (u_radar_radius_km * 2.0);
        vec2 world_pos = u_radar_center + px_offset_km / 111.0; 
        world_pos.x = u_radar_center.x + px_offset_km.x / 111.0;

        vec2 wind = getWindVector(world_pos);
        float wind_speed = length(wind); 

        // 地形抬升
        float elev = getElevation(world_pos);
        float lift_factor = 0.0;
        float baseHum = (u_env_humidity > 0.0) ? u_env_humidity : 0.7;

        if (wind_speed > 10.0) {
            float step = 0.11; 
            float h_x = getElevation(world_pos + vec2(step, 0.0));
            float h_y = getElevation(world_pos + vec2(0.0, step));
            float grad_x = h_x - elev;
            float grad_y = h_y - elev;
            float slopeMagnitude = sqrt(grad_x * grad_x + grad_y * grad_y);
            float terrainSteepness = smoothstep(0.00, 0.02, slopeMagnitude);

            if (terrainSteepness > 0.0) {
                float dot_val = wind.x * grad_x + wind.y * grad_y;
                if (dot_val > 0.0) { // 简化：假设上游足够湿润
                    float effectiveHum = max(baseHum, 0.85); 
                    float moistureEfficiency = smoothstep(0.35, 0.75, effectiveHum);
                    lift_factor = dot_val * 0.15 * moistureEfficiency * terrainSteepness;
                }
            }
        }

        float dbz = 0.0;

        // 气旋渲染
        if (u_has_cyclone > 0) {
            float hemi = (u_cyc_pos.y >= 0.0) ? 1.0 : -1.0;
            vec2 cyc_offset_deg = world_pos - u_cyc_pos;
            vec2 cyc_offset_km;
            cyc_offset_km.y = cyc_offset_deg.y * 111.0;
            cyc_offset_km.x = cyc_offset_deg.x * 111.0 * cos(radians(u_cyc_pos.y));
            float c_dist = length(cyc_offset_km);
            
            if (c_dist < u_cyc_size * 3.5) {
                float intensity = u_cyc_intensity;
                float org = clamp((intensity - 25.0) / 85.0, 0.01, 0.99);
                float angle = atan(cyc_offset_km.y, cyc_offset_km.x); 
                float rotOffset = u_cyc_age * 0.2 * hemi;
                float rmw = (20.0 + u_cyc_size * 0.12) * (1.8 - 0.7 * org);
                float d = c_dist / rmw;

                float biasAngle = rotOffset * 0.7 + PI;
                float angleDiff = cos(angle - biasAngle);
                float asymStrength = 0.7 * (1.0 - org);
                float asymmetry = max(0.2, 1.0 + asymStrength * angleDiff);
                float highFreqNoise = fbm(world_pos * 20.0 + u_time * 0.1, 2);
                vec2 distortUV = world_pos * 4.0;
                float shapeDistort = fbm(vec2(distortUV.x + u_cyc_age*0.05, distortUV.y), 2);

                float spiralTightness = org * 3.0;
                float spiralPhase = angle + hemi * (1.0+spiralTightness) * log(d + 0.1);
                float warp = fbm(world_pos * 3.0, 3) * (1.5 - org) * min(2.0, d);
                float signal = sin(spiralPhase * 2.0 + rotOffset + warp + shapeDistort * 0.1);
                signal = smoothstep(-0.3, 0.7, signal);

                float eyewallWidth = 0.20 - 0.10 * (1.0 - org);
                eyewallWidth *= (0.8 + 0.4 * highFreqNoise);
                float eyewallShape = exp(-pow(d - 1.0, 4.0) / eyewallWidth) * (1.0 + 0.3 * (intensity - 85.0) / 85.0);

                float moatStrength = smoothstep(0.4, 0.8, org);
                float moatBase = smoothstep(1.4, 1.7, d) * (1.0 - smoothstep(2.2, 2.7, d));
                float moatBreaker = fbm(vec2(angle * 1.5, u_cyc_age * 0.01), 2) * (2.0 - asymmetry);
                float connFactor = 1.0 - (moatBase * smoothstep(0.3, 0.9, moatBreaker) * moatStrength);

                float strongCore = 45.0 * eyewallShape;
                float breakupMask = smoothstep(0.25, 0.6, highFreqNoise); 
                strongCore *= (0.95 + 0.1 * breakupMask);
                strongCore += fbm(world_pos * 8.0 + rotOffset, 2) * 15.0 * eyewallShape;
                if (d < 0.5 && org > 0.5) {
                    float holeMask = smoothstep(0.5, 0.0, d);
                    float digFactor = smoothstep(0.5, 0.9, org);
                    strongCore *= (1.0 - holeMask * digFactor * 0.9);
                    if (strongCore < 10.0) strongCore += fbm(world_pos * 40.0, 2) * 8.0;
                }

                float twist = 3.0 * (1.0 - d); 
                float cosT = cos(twist + rotOffset);
                float sinT = sin(twist + rotOffset);
                vec2 twistedPos = vec2(world_pos.x * cosT - world_pos.y * sinT, world_pos.x * sinT + world_pos.y * cosT);
                float noiseBase = fbm(twistedPos * 3.0, 3);
                float commaShape = smoothstep(-0.5, 0.8, angleDiff + 0.3 * noiseBase);
                float rangeLimit = mix(1.2, 3.5, smoothstep(0.0, 0.6, org));
                float rangeMask = 1.0 - smoothstep(0.5, rangeLimit, d);
                float weakCore = 35.0 * noiseBase * commaShape * rangeMask;
                if (org < 0.15) {
                    float cells = smoothstep(0.6, 0.8, noiseBase);
                    weakCore = 30.0 * cells * rangeMask;
                }

                float blend = smoothstep(0.3, 0.7, org);
                float coreDbz = mix(weakCore, strongCore, blend);

                float eyeFillFactor = 1.0 - smoothstep(0.4, 0.65, org);
                if (eyeFillFactor > 0.0 && d < 2.5) { 
                    vec2 warpOffset = vec2(fbm(world_pos * 1.5 + u_cyc_age * 0.05, 2), fbm(world_pos * 1.5 + u_cyc_age * 0.05 + 50.0, 2));
                    float distortedDist = length(cyc_offset_km / rmw + (warpOffset - 0.5) * 0.8);
                    float erosion = fbm(world_pos * 4.0, 3);
                    float blobShape = smoothstep(2.5, 0.2, distortedDist + erosion * 0.5);
                    if (blobShape > 0.0) {
                        float chaoticTexture = fbm(world_pos * 8.0 + u_cyc_age * 0.1, 2);
                        float fillDbz = 60.0 * chaoticTexture;
                        coreDbz = max(coreDbz, fillDbz * blobShape * eyeFillFactor);
                    }
                }

                float distFade = exp(-max(0.0, d - 1.0) / mix(1.8, 5.0, smoothstep(0.1, 0.7, org)));
                float bandInnerCutoff = smoothstep(0.4, 0.8, d);
                float bandAsym = asymmetry;
                if (asymmetry < 0.6) bandAsym *= (0.5 + 0.5 * fbm(world_pos * 10.0, 2));
                float stratiform = 15.0 + 20.0 * smoothstep(-0.5, 0.5, signal);
                float cellNoise = fbm(world_pos * 8.0, 3);
                float convMask = smoothstep(0.6, 0.9, signal) * smoothstep(0.4, 0.7, cellNoise);
                float convective = 0.0;
                if (convMask > 0.1) convective = 30.0 + 25.0 * convMask;
                if (asymmetry < 0.6) {
                    asymmetry *= (0.6 + 0.4 * fbm(world_pos * 8.0, 2));
                    stratiform *= 0.6;
                    convective *= 0.3;
                }
                float bandDbz = max(stratiform, convective);
                bandDbz = bandDbz * distFade * connFactor * bandAsym * bandInnerCutoff;
                dbz = max(coreDbz, bandDbz);
                
                if (d > 1.5 && dbz > 0.0) dbz += (fbm(world_pos * 12.0, 2) - 0.4) * 20.0;

                float globalHum = clamp(baseHum, 0.0, 1.0);
                float humFactor = smoothstep(0.2, 0.7, globalHum);
                float dryPenalty = (1.0 - humFactor) * 4.0 * (240.0 - intensity) / 160.0;
                dbz -= dryPenalty;
                dbz = max(0.0, dbz);
                float maxSupportableDbz = globalHum * 70.0 + 5.0; 
                if (dbz > maxSupportableDbz) dbz = mix(dbz, maxSupportableDbz, 0.2);
            }
        }

        // [环境单体雷暴] - 你的目标代码段
        vec2 windOffset = wind * u_time * 0.05;
        vec2 macroPos = (world_pos * 0.6) - windOffset * 0.5; 
        float macroNoise = fbm(macroPos, 2); 
        vec2 microPos = (world_pos * 5.0) - windOffset; 
        float cellNoise = fbm(microPos, 2); 
        float stormStructure = macroNoise * cellNoise * 2.5;
        
        float baseThreshold = 0.6 - (baseHum * 0.4); 
        
        if (stormStructure > baseThreshold) {
            float intensity = (stormStructure - baseThreshold) / (1.0 - baseThreshold);
            intensity = pow(intensity, 1.5); 
            float grain = random(microPos * 1.0);
            float ambientDbz = 60.0 * intensity + 5.0 * grain;
            ambientDbz *= smoothstep(0.4, 0.8, baseHum);
            dbz = max(dbz, ambientDbz);
        }

        dbz += lift_factor * 0.16; 
        dbz = max(0.0, dbz);
        gl_FragColor = getRadarColor(dbz);
    }
`;

const vsSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

// ============================================================
// JS 物理计算接口 (High Fidelity Physics Mirror)
// ============================================================
const GLSL = {
    f32: (x) => Math.fround(x),
    fract: (x) => { const f = Math.fround(x); return Math.fround(f - Math.floor(f)); },
    mix: (a, b, t) => {
        const fa = Math.fround(a), fb = Math.fround(b), ft = Math.fround(Math.max(0, Math.min(1, t)));
        return Math.fround(fa + (fb - fa) * ft);
    },
    clamp: (x, min, max) => Math.fround(Math.max(min, Math.min(max, x))),
    smoothstep: (edge0, edge1, x) => {
        const f0 = Math.fround(edge0), f1 = Math.fround(edge1), fx = Math.fround(x);
        const t = Math.fround(Math.max(0, Math.min(1, (fx - f0) / (f1 - f0))));
        return Math.fround(t * t * (3.0 - 2.0 * t));
    },
    length: (v) => Math.fround(Math.sqrt(Math.fround(v.x * v.x + v.y * v.y))),
    dot: (v1, v2) => Math.fround(Math.fround(v1.x * v2.x) + Math.fround(v1.y * v2.y)),
    
    // [关键修改] JS 端实现与 Shader 一致的无正弦 Hash12
    random: (st, seed = 0.0) => {
        const px = Math.fround(st.x + seed);
        const py = Math.fround(st.y + seed);
        
        let p3x = Math.fround(GLSL.fract(Math.fround(px * 0.1031)));
        let p3y = Math.fround(GLSL.fract(Math.fround(py * 0.1031)));
        let p3z = Math.fround(GLSL.fract(Math.fround(px * 0.1031)));
        
        const dotVal = Math.fround(
            Math.fround(p3x * Math.fround(p3y + 33.33)) + 
            Math.fround(p3y * Math.fround(p3z + 33.33)) + 
            Math.fround(p3z * Math.fround(p3x + 33.33))
        );
        p3x = Math.fround(p3x + dotVal);
        p3y = Math.fround(p3y + dotVal);
        p3z = Math.fround(p3z + dotVal);
        
        return Math.fround(GLSL.fract(Math.fround(Math.fround(p3x + p3y) * p3z)));
    },
    
    noise: (st, seed) => {
        const i = { x: Math.floor(st.x), y: Math.floor(st.y) };
        const f = { x: GLSL.fract(st.x), y: GLSL.fract(st.y) };
        const a = GLSL.random(i, seed);
        const b = GLSL.random({ x: i.x + 1.0, y: i.y }, seed);
        const c = GLSL.random({ x: i.x, y: i.y + 1.0 }, seed);
        const d = GLSL.random({ x: i.x + 1.0, y: i.y + 1.0 }, seed);
        const u = {
            x: Math.fround(f.x * f.x * (3.0 - 2.0 * f.x)),
            y: Math.fround(f.y * f.y * (3.0 - 2.0 * f.y))
        };
        const mix1 = GLSL.mix(a, b, u.x);
        const term2 = Math.fround((c - a) * u.y * (1.0 - u.x));
        const term3 = Math.fround((d - b) * u.y * u.x);
        return Math.fround(mix1 + term2 + term3);
    },
    fbm: (st, octaves = 2, seed = 0.0) => {
        let value = 0.0;
        let amp = 0.5;
        let p = { x: st.x, y: st.y }; 
        for (let i = 0; i < octaves; i++) {
            value = Math.fround(value + GLSL.noise(p, seed) * amp);
            p.x = Math.fround(p.x * 2.0);
            p.y = Math.fround(p.y * 2.0);
            amp = Math.fround(amp * 0.5);
        }
        return value;
    }
};

// ... getShaderPressure, getShaderWindVector (保持不变) ...
export function getShaderPressure(lon, lat, pressureSystems) {
    let p = 0.0;
    const limit = Math.min(pressureSystems.length, 20);
    for (let i = 0; i < limit; i++) {
        const sys = pressureSystems[i];
        let dx = lon - sys.x;
        if (Math.abs(dx) > 180.0) { dx = dx > 0.0 ? dx - 360.0 : dx + 360.0; }
        const dy = lat - sys.y;
        const val = sys.strength * Math.exp(-0.5 * ( (dx*dx)/(sys.sigmaX*sys.sigmaX) + (dy*dy)/(sys.sigmaY*sys.sigmaY) ));
        p += val;
    }
    return 1012.0 + p;
}

export function getShaderWindVector(lon, lat, cyclone, pressureSystems) {
    const dDeg = 0.5;
    const p_x_plus = getShaderPressure(lon + dDeg, lat, pressureSystems);
    const p_x_minus = getShaderPressure(lon - dDeg, lat, pressureSystems);
    const p_y_plus = getShaderPressure(lon, lat + dDeg, pressureSystems);
    const p_y_minus = getShaderPressure(lon, lat - dDeg, pressureSystems);
    const gradX = p_x_plus - p_x_minus;
    const gradY = p_y_plus - p_y_minus;
    const f_sign = lat >= 0.0 ? 1.0 : -1.0; 
    const bgScale = 4.0;
    const u_bg = -gradY * bgScale * f_sign;
    const v_bg = gradX * bgScale * f_sign;
    let u_cyc = 0.0;
    let v_cyc = 0.0;
    if (cyclone && cyclone.status === 'active') {
        const dx = lon - cyclone.lon;
        const cycLatRad = cyclone.lat * Math.PI / 180.0;
        const dx_km = dx * 111.0 * Math.cos(cycLatRad);
        const dy_km = (lat - cyclone.lat) * 111.0;
        const dist = Math.sqrt(dx_km*dx_km + dy_km*dy_km);
        const rmw = 20.0 + cyclone.circulationSize * 0.15;
        let v_tan = 0.0;
        const intensity = cyclone.intensity * 0.514; 
        if (dist < cyclone.circulationSize * 4.0) {
            if (dist < rmw) { v_tan = intensity * (dist / rmw); } 
            else { v_tan = intensity * Math.pow(rmw / dist, 0.6); }
            const angle = Math.atan2(dy_km, dx_km);
            const rot = cyclone.lat >= 0.0 ? 1.5708 : -1.5708;
            const wind_angle = angle + rot;
            u_cyc = Math.cos(wind_angle) * v_tan;
            v_cyc = Math.sin(wind_angle) * v_tan;
        }
    }
    return { u: u_bg + u_cyc, v: v_bg + v_cyc, magnitude: Math.sqrt((u_bg+u_cyc)**2 + (v_bg+v_cyc)**2) };
}

export function calculateRadarDbz(lon, lat, state, seed = 0.0) {
    // 即使没有气旋，我们也可能因为环境对流而有 dBZ
    const u_time = (state.cyclone && state.cyclone.status === 'active') ? state.cyclone.age : 0;
    const PI = Math.PI;
    
    // 1. 获取基础数据
    const elev = getElevationAt(lon, lat);
    const vec = getShaderWindVector(lon, lat, state.cyclone, state.pressureSystems);
    const windSpeed = vec.magnitude;
    const wind = { x: vec.u, y: vec.v };

    let effectiveHum = 0.7;
    if (state.u_env_humidity !== undefined) {
        effectiveHum = state.u_env_humidity;
    } else {
        effectiveHum = calculateBackgroundHumidity(
            lon, lat, state.pressureSystems, 
            state.currentMonth, state.cyclone, state.GlobalTemp
        ) / 100.0;
    }

    let lift_factor = 0.0;
    if (windSpeed > 10.0) {
        const step = 0.11;
        const h0 = elev;
        const hx = getElevationAt(lon + step, lat);
        const hy = getElevationAt(lon, lat + step);
        const gradX = hx - h0;
        const gradY = hy - h0;
        const slopeMagnitude = Math.sqrt(gradX*gradX + gradY*gradY);
        const terrainSteepness = GLSL.smoothstep(0.00, 0.02, slopeMagnitude);
        if (terrainSteepness > 0.0) {
            const dotVal = wind.x * gradX + wind.y * gradY;
            if (dotVal > 0) {
                const moistureEfficiency = GLSL.smoothstep(0.35, 0.75, effectiveHum);
                lift_factor = dotVal * 0.15 * moistureEfficiency * terrainSteepness;
            }
        }
    }

    let dbz = 0.0;
    
    if (state.cyclone && state.cyclone.status === 'active') {
        const cyc = state.cyclone;
        const u_cyc_pos = { x: cyc.lon, y: cyc.lat };
        const u_cyc_size = cyc.circulationSize;
        const u_cyc_intensity = cyc.intensity;
        const u_cyc_age = cyc.age;
        const world_pos = { x: lon, y: lat };
        const hemi = (u_cyc_pos.y >= 0.0) ? 1.0 : -1.0;
        
        const dx = (lon - u_cyc_pos.x) * 111.0 * Math.cos(u_cyc_pos.y * PI / 180.0);
        const dy = (lat - u_cyc_pos.y) * 111.0;
        const cyc_offset_km = { x: dx, y: dy };
        const c_dist = GLSL.length(cyc_offset_km);

        if (c_dist < u_cyc_size * 3.5) {
            const intensity = u_cyc_intensity;
            const org = GLSL.clamp((intensity - 25.0) / 85.0, 0.01, 0.99);
            const angle = Math.atan2(cyc_offset_km.y, cyc_offset_km.x);
            const rotOffset = u_cyc_age * 0.2 * hemi;
            const rmw = (20.0 + u_cyc_size * 0.12) * (1.8 - 0.7 * org);
            const d = c_dist / rmw;

            const biasAngle = rotOffset * 0.7 + PI;
            const angleDiff = Math.cos(angle - biasAngle);
            const asymStrength = 0.7 * (1.0 - org);
            let asymmetry = Math.max(0.2, 1.0 + asymStrength * angleDiff);
            
            const st_highFreq = { x: world_pos.x * 20.0 + u_time * 0.1, y: world_pos.y * 20.0 + u_time * 0.1 };
            const highFreqNoise = GLSL.fbm(st_highFreq, 2, seed);
            
            const distortUV = { x: world_pos.x * 4.0, y: world_pos.y * 4.0 };
            const shapeDistort = GLSL.fbm({ x: distortUV.x + u_cyc_age*0.05, y: distortUV.y }, 2, seed);

            const spiralTightness = org * 3.0;
            const spiralPhase = angle + hemi * (1.0 + spiralTightness) * Math.log(d + 0.1);
            const warpSt = { x: world_pos.x * 3.0, y: world_pos.y * 3.0 };
            const warp = GLSL.fbm(warpSt, 3, seed) * (1.5 - org) * Math.min(2.0, d);
            
            let signal = Math.sin(spiralPhase * 2.0 + rotOffset + warp + shapeDistort * 0.1);
            signal = GLSL.smoothstep(-0.3, 0.7, signal);

            let eyewallWidth = 0.20 - 0.10 * (1.0 - org);
            eyewallWidth *= (0.8 + 0.4 * highFreqNoise);
            const eyewallShape = Math.exp(-Math.pow(d - 1.0, 4.0) / eyewallWidth) * (1.0 + 0.3 * (intensity - 85.0) / 85.0);

            const moatStrength = GLSL.smoothstep(0.4, 0.8, org);
            const moatBase = GLSL.smoothstep(1.4, 1.7, d) * (1.0 - GLSL.smoothstep(2.2, 2.7, d));
            const moatBreakerSt = { x: angle * 1.5, y: u_cyc_age * 0.01 };
            const moatBreaker = GLSL.fbm(moatBreakerSt, 2, seed) * (2.0 - asymmetry);
            const connFactor = 1.0 - (moatBase * GLSL.smoothstep(0.3, 0.9, moatBreaker) * moatStrength);

            let strongCore = 45.0 * eyewallShape;
            const breakupMask = GLSL.smoothstep(0.25, 0.6, highFreqNoise);
            strongCore *= (0.95 + 0.1 * breakupMask);
            const coreNoiseSt = { x: world_pos.x * 8.0 + rotOffset, y: world_pos.y * 8.0 + rotOffset };
            strongCore += GLSL.fbm(coreNoiseSt, 2, seed) * 15.0 * eyewallShape;

            if (d < 0.5 && org > 0.5) {
                const holeMask = GLSL.smoothstep(0.5, 0.0, d);
                const digFactor = GLSL.smoothstep(0.5, 0.9, org);
                strongCore *= (1.0 - holeMask * digFactor * 0.9);
                if (strongCore < 10.0) {
                    const eyeFillSt = { x: world_pos.x * 40.0, y: world_pos.y * 40.0 };
                    strongCore += GLSL.fbm(eyeFillSt, 2, seed) * 8.0;
                }
            }

            const twist = 3.0 * (1.0 - d);
            const cosT = Math.cos(twist + rotOffset);
            const sinT = Math.sin(twist + rotOffset);
            const twistedPos = { x: world_pos.x * cosT - world_pos.y * sinT, y: world_pos.x * sinT + world_pos.y * cosT };
            const weakNoiseSt = { x: twistedPos.x * 3.0, y: twistedPos.y * 3.0 };
            const noiseBase = GLSL.fbm(weakNoiseSt, 3, seed);
            const commaShape = GLSL.smoothstep(-0.5, 0.8, angleDiff + 0.3 * noiseBase);
            const rangeLimit = GLSL.mix(1.2, 3.5, GLSL.smoothstep(0.0, 0.6, org));
            const rangeMask = 1.0 - GLSL.smoothstep(0.5, rangeLimit, d);
            
            let weakCore = 35.0 * noiseBase * commaShape * rangeMask;
            if (org < 0.15) {
                const cells = GLSL.smoothstep(0.6, 0.8, noiseBase);
                weakCore = 30.0 * cells * rangeMask;
            }

            const blend = GLSL.smoothstep(0.3, 0.7, org);
            let coreDbz = GLSL.mix(weakCore, strongCore, blend);

            const eyeFillFactor = 1.0 - GLSL.smoothstep(0.4, 0.65, org);
            if (eyeFillFactor > 0.0 && d < 2.5) {
                const warpOffset = {
                    x: GLSL.fbm({ x: world_pos.x * 1.5 + u_cyc_age * 0.05, y: world_pos.y * 1.5 + u_cyc_age * 0.05 }, 2, seed),
                    y: GLSL.fbm({ x: world_pos.x * 1.5 + u_cyc_age * 0.05 + 50.0, y: world_pos.y * 1.5 + u_cyc_age * 0.05 + 50.0 }, 2, seed)
                };
                const distDistortedV = {
                    x: cyc_offset_km.x / rmw + (warpOffset.x - 0.5) * 0.8,
                    y: cyc_offset_km.y / rmw + (warpOffset.y - 0.5) * 0.8
                };
                const distortedDist = GLSL.length(distDistortedV);
                const erosionSt = { x: world_pos.x * 4.0, y: world_pos.y * 4.0 };
                const erosion = GLSL.fbm(erosionSt, 3, seed);
                const blobShape = GLSL.smoothstep(2.5, 0.2, distortedDist + erosion * 0.5);
                if (blobShape > 0.0) {
                    const chaoticSt = { x: world_pos.x * 8.0 + u_cyc_age * 0.1, y: world_pos.y * 8.0 + u_cyc_age * 0.1 };
                    const chaoticTexture = GLSL.fbm(chaoticSt, 2, seed);
                    const fillDbz = 60.0 * chaoticTexture;
                    coreDbz = Math.max(coreDbz, fillDbz * blobShape * eyeFillFactor);
                }
            }

            const distFade = Math.exp(-Math.max(0.0, d - 1.0) / GLSL.mix(1.8, 5.0, GLSL.smoothstep(0.1, 0.7, org)));
            const bandInnerCutoff = GLSL.smoothstep(0.4, 0.8, d);
            
            let bandAsym = asymmetry;
            if (asymmetry < 0.6) bandAsym *= (0.5 + 0.5 * GLSL.fbm({ x: world_pos.x * 10.0, y: world_pos.y * 10.0 }, 2, seed));

            let stratiform = 15.0 + 20.0 * GLSL.smoothstep(-0.5, 0.5, signal);
            const cellNoiseSt = { x: world_pos.x * 8.0, y: world_pos.y * 8.0 };
            const cellNoise = GLSL.fbm(cellNoiseSt, 3, seed);
            const convMask = GLSL.smoothstep(0.6, 0.9, signal) * GLSL.smoothstep(0.4, 0.7, cellNoise);
            let convective = 0.0;
            if (convMask > 0.1) convective = 30.0 + 25.0 * convMask;
            if (asymmetry < 0.6) {
                asymmetry *= (0.6 + 0.4 * GLSL.fbm(weakNoiseSt, 2, seed));
                stratiform *= 0.6;
                convective *= 0.3;
            }

            let bandDbz = Math.max(stratiform, convective);
            bandDbz = bandDbz * distFade * connFactor * bandAsym * bandInnerCutoff;

            dbz = Math.max(coreDbz, bandDbz);

            // Texture enhance
            if (d > 1.5 && dbz > 0.0) {
                const texEnhanceSt = { x: world_pos.x * 12.0, y: world_pos.y * 12.0 };
                dbz += (GLSL.fbm(texEnhanceSt, 2, seed) - 0.4) * 20.0;
            }

            // Global Humidity check
            let globalHum = effectiveHum;
            globalHum = GLSL.clamp(globalHum, 0.0, 1.0);
            
            const humFactor = GLSL.smoothstep(0.2, 0.7, globalHum);
            const dryPenalty = (1.0 - humFactor) * 4.0 * (240.0 - intensity) / 160.0;
            dbz -= dryPenalty;
            dbz = Math.max(0.0, dbz);

            const maxSupportableDbz = globalHum * 70.0 + 5.0;
            if (dbz > maxSupportableDbz) {
                dbz = GLSL.mix(dbz, maxSupportableDbz, 0.2);
            }
        }
    }

    // --- C. 单体雷暴 / 环境对流 (CPU 实现) ---
    // ----------------------------------------------------
    const world_pos = { x: lon, y: lat };
    const windOffset = { x: wind.x * u_time * 0.05, y: wind.y * u_time * 0.05 };
    
    // Macro
    // [关键修复] 将 Y 轴 multiplier 从 0.8 改为 0.6，与 Shader 保持一致
    const macroPos = { x: (world_pos.x * 0.6) - windOffset.x * 0.5, y: (world_pos.y * 0.6) - windOffset.y * 0.5 };
    const macroNoise = GLSL.fbm(macroPos, 2, seed);

    // Micro
    const microPos = { x: (world_pos.x * 5.0) - windOffset.x, y: (world_pos.y * 5.0) - windOffset.y };
    const cellNoise = GLSL.fbm(microPos, 2, seed);

    const stormStructure = macroNoise * cellNoise * 2.5;
    const baseThreshold = 0.6 - (effectiveHum * 0.4);

    if (stormStructure > baseThreshold) {
        let intensity = (stormStructure - baseThreshold) / (1.0 - baseThreshold);
        intensity = Math.pow(intensity, 1.5);

        // Grain
        const grainSt = { x: microPos.x * 1.0, y: microPos.y * 1.0 };
        const grain = GLSL.random(grainSt, seed);

        let ambientDbz = 60.0 * intensity + 5.0 * grain;
        
        // 湿度削减
        ambientDbz *= GLSL.smoothstep(0.4, 0.8, effectiveHum);
        
        dbz = Math.max(dbz, ambientDbz);
    }
    // ----------------------------------------------------

    dbz += lift_factor * 0.16;
    return Math.max(0, dbz);
}

// ============================================================
// WebGL 控制器 Class
// ============================================================
export class RadarRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');
        this.sysParamsCache = new Float32Array(20 * 4);
        this.sysStrengthCache = new Float32Array(20);
        if (!this.gl) {
            console.error("WebGL not supported");
            return;
        }
        this.init();
        
    }

    init() {
        const gl = this.gl;
        
        // 1. 创建 Program
        const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);
        this.program = this.createProgram(vs, fs);

        // 2. 绑定顶点数据 (全屏矩形)
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1, 
            -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);

        this.a_position = gl.getAttribLocation(this.program, "a_position");
        
        // 3. 获取 Uniform 位置
        this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");
        this.u_time = gl.getUniformLocation(this.program, "u_time");
        this.u_radar_center = gl.getUniformLocation(this.program, "u_radar_center");
        this.u_radar_radius_km = gl.getUniformLocation(this.program, "u_radar_radius_km");
        this.u_noise_seed = gl.getUniformLocation(this.program, "u_noise_seed"); // [新增]
        
        this.u_sys_params = this.gl.getUniformLocation(this.program, "u_sys_params");
        this.u_sys_strength = this.gl.getUniformLocation(this.program, "u_sys_strength");
        
        this.u_sys_count = this.gl.getUniformLocation(this.program, "u_sys_count");
        this.u_terrain_map = this.gl.getUniformLocation(this.program, "u_terrain_map");
        this.terrainTexture = this.gl.createTexture();
        
        this.u_env_humidity = this.gl.getUniformLocation(this.program, 'u_env_humidity'),
        this.u_has_cyclone = gl.getUniformLocation(this.program, "u_has_cyclone");
        this.u_cyc_pos = gl.getUniformLocation(this.program, "u_cyc_pos");
        this.u_cyc_size = gl.getUniformLocation(this.program, "u_cyc_size");
        this.u_cyc_intensity = gl.getUniformLocation(this.program, "u_cyc_intensity");
        this.u_cyc_age = gl.getUniformLocation(this.program, "u_cyc_age");
    }

    loadTerrainTexture(imageElement) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.terrainTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageElement);
        // 设置参数：线性插值 (平滑)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); 
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    render(state, width, height, envHumidity, noiseSeed = 0.0) { // [新增] seed 参数
        const gl = this.gl;
        
        gl.viewport(0, 0, width, height);
        // 在开始渲染之前清除颜色缓冲区
        gl.clearColor(0.0, 0.0, 0.0, 0.0); // 设置清除颜色为透明黑色
        gl.clear(gl.COLOR_BUFFER_BIT);

        // [修改] 如果模拟已结束（气旋消散），则直接清空画面，不再渲染环境雷暴
        if (state.cyclone && state.cyclone.status === 'dissipated') {
            return;
        }
        
        gl.useProgram(this.program);

        if (state.pressureSystems) {
            // [修改] 使用预分配的数组，而不是 new Float32Array
            // 重置数组内容（可选，取决于逻辑，如果每次都完全重写则不需要 fill 0）
            this.sysParamsCache.fill(0); 
            this.sysStrengthCache.fill(0);

            const limit = Math.min(state.pressureSystems.length, 20);
            
            for (let i = 0; i < limit; i++) {
                const p = state.pressureSystems[i];
                this.sysParamsCache[i * 4 + 0] = p.x;
                this.sysParamsCache[i * 4 + 1] = p.y;
                this.sysParamsCache[i * 4 + 2] = p.sigmaX;
                this.sysParamsCache[i * 4 + 3] = p.sigmaY;
                
                this.sysStrengthCache[i] = p.strength;
            }

            // 上传数据
            gl.uniform4fv(this.u_sys_params, this.sysParamsCache);
            gl.uniform1fv(this.u_sys_strength, this.sysStrengthCache);
            gl.uniform1i(this.u_sys_count, limit);
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.terrainTexture);
        gl.uniform1i(this.u_terrain_map, 0);
        // 绑定顶点
        gl.enableVertexAttribArray(this.a_position);
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, false, 0, 0);
        // 传递参数
        gl.uniform2f(this.u_resolution, width, height);
        
        // [新增] 传递随机种子
        gl.uniform1f(this.u_noise_seed, noiseSeed);

        let shaderTime = 0.0;

        // 1. 判断逻辑：
        // 如果气旋处于活跃状态，我们直接使用气旋的“寿命 (age)”作为时间基准。
        // 这样，只有当 state.cyclone.age 发生变化时（模拟走了一步），shaderTime 才会变。
        // 在两帧之间，画面会保持完全静止，直到下一步模拟发生。
        if (state.cyclone && state.cyclone.status === 'active') {
            
            // age 通常是整数小时 (0, 3, 6, 9...)
            // 我们直接用它。Shader 里原本是 * 0.02，现在变成 * age。
            // 比如 age 从 3 变成 6，Shader 里的时间就跳跃 3 个单位。
            // 这种跳跃会导致云层“瞬移”一下，正好符合“每一步移动一次”的感觉。
            shaderTime = state.cyclone.age; 

        } else {
            // 2. 如果没有气旋（待机状态），可以使用系统时间让它缓慢飘动，或者保持静止
            // 这里我们保持微弱的飘动，作为待机屏保
            shaderTime = performance.now() / 1000.0;
        }

        // 3. 传递给 Shader
        // 确保使用 init 中获取的正确地址 this.u_time
        if (this.u_time) {
            gl.uniform1f(this.u_time, shaderTime);
        }
        gl.uniform2f(this.u_radar_center, state.siteLon, state.siteLat);
        
        // 雷达半径 (物理)
        gl.uniform1f(this.u_radar_radius_km, 460.0);

        // 气旋参数
        if (state.cyclone && state.cyclone.status === 'active') {
            gl.uniform1i(this.u_has_cyclone, 1);
            gl.uniform2f(this.u_cyc_pos, state.cyclone.lon, state.cyclone.lat);
            gl.uniform1f(this.u_cyc_size, state.cyclone.circulationSize);
            gl.uniform1f(this.u_cyc_intensity, state.cyclone.intensity);
            gl.uniform1f(this.u_cyc_age, state.cyclone.age);
        } else {
            gl.uniform1i(this.u_has_cyclone, 0);
        }
        let humValue = (envHumidity !== undefined) ? envHumidity : 0.8;
        gl.uniform1f(this.u_env_humidity, humValue);
        // Draw
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    createShader(type, source) {
        const s = this.gl.createShader(type);
        this.gl.shaderSource(s, source);
        this.gl.compileShader(s);
        if (!this.gl.getShaderParameter(s, this.gl.COMPILE_STATUS)) {
            console.error(this.gl.getShaderInfoLog(s));
            this.gl.deleteShader(s);
            return null;
        }
        return s;
    }

    createProgram(vs, fs) {
        const p = this.gl.createProgram();
        this.gl.attachShader(p, vs);
        this.gl.attachShader(p, fs);
        this.gl.linkProgram(p);
        return p;
    }
}