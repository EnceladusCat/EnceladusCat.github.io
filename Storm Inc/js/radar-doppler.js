/**
 * radar-doppler.js
 * 负责处理 WebGL 多普勒雷达（径向速度）渲染
 * 核心原理：计算风场矢量在雷达视线方向上的投影分量，并模拟多普勒速度折叠
 */
import { getWindVectorAt } from './cyclone-model.js';
import { getElevationAt } from './terrain-data.js';

// ============================================================
// GLSL Fragment Shader (多普勒物理核心)
// ============================================================
const fsSource = `
    precision highp float;

    // --- Uniforms ---
    uniform vec2 u_resolution;       // 画布尺寸
    uniform float u_time;            // 时间
    uniform vec2 u_radar_center;     // 雷达中心 (经纬度)
    uniform float u_radar_radius_km; // 雷达半径 (km)
    
    // 气旋参数
    uniform int u_has_cyclone;       
    uniform vec2 u_cyc_pos;          
    uniform float u_cyc_size;        
    uniform float u_cyc_intensity;   
    uniform float u_cyc_age;         

    uniform vec4 u_sys_params[20]; 
    uniform float u_sys_strength[20];
    
    uniform int u_sys_count;
    uniform sampler2D u_terrain_map; // 地形 (用于简单的杂波过滤)

    const float PI = 3.14159265359;
    const float DEG_TO_RAD = 0.01745329251;
    const float NYQUIST_VELOCITY = 50.0; // [设置] 最大不模糊速度 m/s (约 97 kts)

    // --- 速度折叠逻辑 ---
    float foldVelocity(float v) {
        // 使用 mod 运算模拟相位折叠
        // 将速度映射到 [-Vmax, +Vmax] 区间内
        // 核心公式: mod(v + Vmax, 2 * Vmax) - Vmax
        return mod(v + NYQUIST_VELOCITY, 2.0 * NYQUIST_VELOCITY) - NYQUIST_VELOCITY;
    }

    // --- 颜色映射：Velocity Ramp ---
    // Inbound (负值): Cool colors (Green/Blue) -> 朝向雷达
    // Outbound (正值): Warm colors (Red/Yellow) -> 远离雷达
    // Zero: Grey/White
    vec4 getVelocityColor(float v) {
        // v 单位: m/s
        
        // 阈值过滤：太小的速度显示为灰色/透明，模拟静风或杂波抑制
        if (abs(v) < 1.5) {
            return vec4(0.6, 0.6, 0.6, 0.2); // 灰色弱回波
        }

        vec3 col = vec3(0.0);
        float alpha = 0.9;
        
        // 归一化强度，用于平滑过渡 (0~10 作为一个区间)
        float step = 10.0; 

        if (v < 0.0) {
            // === Inbound (负值) ===
            float av = abs(v);
            
            if (av < 10.0) {
                // 0 ~ -10: 浅绿 -> 鲜绿
                col = mix(vec3(0.6, 0.8, 0.6), vec3(0.0, 0.8, 0.0), av / 10.0);
            } else if (av < 20.0) {
                // -10 ~ -20: 鲜绿 -> 深绿
                col = mix(vec3(0.0, 0.8, 0.0), vec3(0.0, 0.4, 0.0), (av - 10.0) / 10.0);
            } else if (av < 30.0) {
                // -20 ~ -30: 深绿 -> 亮蓝
                col = mix(vec3(0.0, 0.4, 0.0), vec3(0.0, 0.6, 1.0), (av - 20.0) / 10.0);
            } else if (av < 40.0) {
                // -30 ~ -40: 亮蓝 -> 深蓝
                col = mix(vec3(0.0, 0.6, 1.0), vec3(0.0, 0.0, 0.8), (av - 30.0) / 10.0);
            } else {
                // < -40: 深蓝 -> 紫色 (极强)
                col = mix(vec3(0.0, 0.0, 0.8), vec3(0.6, 0.0, 1.0), clamp((av - 40.0) / 10.0, 0.0, 1.0));
            }
        } else {
            // === Outbound (正值) ===
            if (v < 10.0) {
                // 0 ~ 10: 浅灰黄 -> 橙黄
                col = mix(vec3(0.8, 0.8, 0.6), vec3(1.0, 0.8, 0.0), v / 10.0);
            } else if (v < 20.0) {
                // 10 ~ 20: 橙黄 -> 橙红
                col = mix(vec3(1.0, 0.8, 0.0), vec3(1.0, 0.5, 0.0), (v - 10.0) / 10.0);
            } else if (v < 30.0) {
                // 20 ~ 30: 橙红 -> 鲜红
                col = mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 0.0, 0.0), (v - 20.0) / 10.0);
            } else if (v < 40.0) {
                // 30 ~ 40: 鲜红 -> 深红
                col = mix(vec3(1.0, 0.0, 0.0), vec3(0.5, 0.0, 0.0), (v - 30.0) / 10.0);
            } else {
                // > 40: 深红 -> 粉/白 (极强)
                col = mix(vec3(0.5, 0.0, 0.0), vec3(1.0, 0.6, 1.0), clamp((v - 40.0) / 10.0, 0.0, 1.0));
            }
        }

        return vec4(col, alpha);
    }
    // ------------------------------------------
    // 物理计算辅助函数 (复用自 radar-system.js)
    // ------------------------------------------
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
        float dist_ratio = length(offset) * 2.0;
        
        // 简单的圆形遮罩
        if (dist_ratio > 0.98) discard; 

        // 物理距离映射
        vec2 px_offset_km = offset * (u_radar_radius_km * 2.0);
        vec2 world_pos = u_radar_center + px_offset_km / 111.0; 
        world_pos.x = u_radar_center.x + px_offset_km.x / 111.0;

        // 1. 获取该点的真实风矢量 (u, v) - m/s
        vec2 wind = getWindVector(world_pos);

        // 2. 计算雷达视线方向矢量 (Radar Beam Direction)
        vec2 beam_dir = normalize(offset); 
        
        // 3. 计算真实径向速度 (Radial Velocity)
        // 正值=远离(红), 负值=靠近(绿)
        float radial_v = dot(wind, beam_dir);

        // 4. [新增] 应用速度折叠 (Velocity Aliasing)
        float folded_v = foldVelocity(radial_v);

        gl_FragColor = getVelocityColor(folded_v);
    }
`;

const vsSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

// ============================================================
// WebGL 控制器 Class (复用 RadarRenderer 结构)
// ============================================================
export class DopplerRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');
        if (!this.gl) {
            console.error("WebGL not supported for Doppler");
            return;
        }
        this.init();
    }

    init() {
        const gl = this.gl;
        const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);
        this.program = this.createProgram(vs, fs);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

        this.a_position = gl.getAttribLocation(this.program, "a_position");
        
        this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");
        this.u_time = gl.getUniformLocation(this.program, "u_time");
        this.u_radar_center = gl.getUniformLocation(this.program, "u_radar_center");
        this.u_radar_radius_km = gl.getUniformLocation(this.program, "u_radar_radius_km");
        this.u_noise_seed = gl.getUniformLocation(this.program, "u_noise_seed");
        
        this.u_sys_params = this.gl.getUniformLocation(this.program, "u_sys_params");
        this.u_sys_strength = this.gl.getUniformLocation(this.program, "u_sys_strength");
        this.u_sys_count = this.gl.getUniformLocation(this.program, "u_sys_count");
        this.u_terrain_map = this.gl.getUniformLocation(this.program, "u_terrain_map");
        this.terrainTexture = this.gl.createTexture();
        
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
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); 
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    render(state, width, height) {
        const gl = this.gl;
        gl.viewport(0, 0, width, height);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (state.cyclone && state.cyclone.status === 'dissipated') return;

        gl.useProgram(this.program);

        if (state.pressureSystems) {
            const paramsArray = new Float32Array(20 * 4);
            const strengthArray = new Float32Array(20);
            const limit = Math.min(state.pressureSystems.length, 20);
            for (let i = 0; i < limit; i++) {
                const p = state.pressureSystems[i];
                paramsArray[i * 4 + 0] = p.x;
                paramsArray[i * 4 + 1] = p.y;
                paramsArray[i * 4 + 2] = p.sigmaX;
                paramsArray[i * 4 + 3] = p.sigmaY;
                strengthArray[i] = p.strength;
            }
            gl.uniform4fv(this.u_sys_params, paramsArray);
            gl.uniform1fv(this.u_sys_strength, strengthArray);
            gl.uniform1i(this.u_sys_count, limit);
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.terrainTexture);
        gl.uniform1i(this.u_terrain_map, 0);

        gl.enableVertexAttribArray(this.a_position);
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, false, 0, 0);

        gl.uniform2f(this.u_resolution, width, height);
        // 多普勒雷达不需要随机种子
        gl.uniform1f(this.u_noise_seed, 0.0);

        let shaderTime = performance.now() / 1000.0;
        if (state.cyclone && state.cyclone.status === 'active') {
            shaderTime = state.cyclone.age;
        }
        if (this.u_time) gl.uniform1f(this.u_time, shaderTime);
        
        gl.uniform2f(this.u_radar_center, state.siteLon, state.siteLat);
        gl.uniform1f(this.u_radar_radius_km, 460.0);

        if (state.cyclone && state.cyclone.status === 'active') {
            gl.uniform1i(this.u_has_cyclone, 1);
            gl.uniform2f(this.u_cyc_pos, state.cyclone.lon, state.cyclone.lat);
            gl.uniform1f(this.u_cyc_size, state.cyclone.circulationSize);
            gl.uniform1f(this.u_cyc_intensity, state.cyclone.intensity);
            gl.uniform1f(this.u_cyc_age, state.cyclone.age);
        } else {
            gl.uniform1i(this.u_has_cyclone, 0);
        }

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