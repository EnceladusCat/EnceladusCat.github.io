/**
 * visualization.js
 * 包含所有 D3.js 绘图函数。
 */
import { getCategory, getPressureAt, windToPressure, directionToCompass, createGeoCircle, unwrapLongitude, calculateHollandPressure, getSST, calculateDistance } from './utils.js';
import { getWindVectorAt } from './cyclone-model.js';
import { generatePathForecasts } from './forecast-models.js';
import { getElevationAt, getLandStatus } from './terrain-data.js';

// [新增] 简单的伪随机噪声函数 (用于模拟大尺度湿度波动)
function pseudoNoise(x, y) {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
}

// [新增] 更加平滑的噪声 (双线性插值)
export function smoothNoise(x, y) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const u = x - i;
    const v = y - j;
    
    // 平滑插值公式
    const smooth = t => t * t * (3 - 2 * t);
    const uSm = smooth(u);
    const vSm = smooth(v);

    const n00 = pseudoNoise(i, j);
    const n10 = pseudoNoise(i + 1, j);
    const n01 = pseudoNoise(i, j + 1);
    const n11 = pseudoNoise(i + 1, j + 1);

    const x1 = n00 + (n10 - n00) * uSm;
    const x2 = n01 + (n11 - n01) * uSm;
    
    return x1 + (x2 - x1) * vSm;
}

// [新增/核心] 计算某一点的背景湿度 (不含气旋核心水汽)
// 这就是你以后用于物理计算“干空气入侵”的接口
export function calculateBackgroundHumidity(lon, lat, pressureSystems, currentMonth, cyclone = null, globalTemp = 289) {
    const bgTemp = globalTemp;
    // 1. 基础反比逻辑：气压越低，湿度越高
    const p = getPressureAt(lon, lat, pressureSystems);
    let hum = 83 + (1010 - p) * 1.3 + 3 * (bgTemp - 289);

    // 2. 柏林噪声叠加 (大尺度水汽输送)
    const timeFactor = (cyclone && cyclone.age) ? cyclone.age * 0.02 : 0;
    const scale = 0.06; 
    const noise = smoothNoise(lon * scale + timeFactor, lat * scale);
    hum += (noise - 0.5) * 35;

    // 3. 纬度修正 (赤道湿，两极干)
    const latRad = lat * Math.PI / 180;
    hum *= (0.6 + 0.4 * Math.cos(latRad));

    const isNorth = lat > 0;
    let baseDryLat = isNorth ? 46 : -46;
    const systemsList = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems?.lower || []);
    if (systemsList.length > 0) {
        const subpolarLow = systemsList.find(s => 
            s.baseSigmaX > 200 && 
            s.strength < -15 &&   
            (isNorth ? s.y > 30 : s.y < -30)
        );

        if (subpolarLow) {
            const offset = isNorth ? 5 : -8;
            baseDryLat = subpolarLow.y + offset;
        }
    }

    // B. [新增] 计算罗斯贝波 (Rossby Wave) 偏移
    // 引入经度(lon)作为变量，使急流产生弯曲
    
    // 波数：环绕地球一圈有几个波 (通常 3-6 个)
    const waveNumber = 5.0;
    const phaseSpeed = (cyclone ? cyclone.age : 0) * 0.02;
    
    // 振幅：波动的南北幅度 (度)
    const waveAmplitude = 6.0; 

    // 计算正弦波偏移
    const rossbyOffset = Math.sin((lon * Math.PI / 180) * waveNumber + phaseSpeed) * waveAmplitude;

    // C. [新增] 叠加急流噪声 (Jet Stream Turbulence)
    // 让线条不那么平滑，增加随机扰动
    // timeFactor 已经在函数前面定义了
    const jetNoise = (smoothNoise(lon * 0.08, timeFactor) - 0.5) * 8.0;

    // D. 合成最终的目标干燥纬度
    // Target = 基础位置 + 长波摆动 + 短波噪声
    const targetDryLat = baseDryLat + rossbyOffset + jetNoise;

    // E. 应用高斯分布扣减
    // 在 targetDryLat 附近形成干燥区
    const dryBandWidth = 200; // 影响宽度 (sigma^2)
    const westerliesDryFactor = Math.exp(-Math.pow(lat - targetDryLat, 2) / dryBandWidth);
    hum -= westerliesDryFactor * 100;

    // 4. 地形与焚风效应 (Foehn Effect)
    const elevation = getElevationAt(lon, lat);
    
    if (elevation > 0) {
        hum -= (elevation / 200) * 15;
    }

    // B. 焚风效应 (升级版：逆风回溯拖尾)
    if (cyclone) {
        const vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems);
        const len = Math.sqrt(vec.u * vec.u + vec.v * vec.v);
        // 只有风速足够大才产生显著拖尾 (>10kt)
        let windWeight = (len - 15.0) / (30.0 - 15.0);
        windWeight = Math.max(0, Math.min(1, windWeight)); // Clamp 到 0~1

        // 只有当有权重时才计算，节省性能
        if (windWeight > 0.01) {
            const dirU = vec.u / len;
            const dirV = vec.v / len;

            // --- 配置参数 ---
            const traceSteps = 30;      // 回溯步数 (步数越多拖尾越精细，但性能开销大)
            const stepSize = 0.1;      // 每步步长 (度)，0.1度 ≈ 10km
            const decayFactor = 0.2;   // 距离衰减系数 (越小拖尾越长)
            
            let maxDryImpact = 0;      // 记录路径上最大的干燥影响

            // 开始回溯循环
            for (let i = 1; i <= traceSteps; i++) {
                // 当前回溯距离
                const dist = i * stepSize;
                
                // 计算上风点坐标
                const upLon = lon - (dirU * dist);
                const upLat = lat - (dirV * dist);
                
                // 获取上风点海拔
                const upElevation = getElevationAt(upLon, upLat);
                const elevationDiff = upElevation - elevation;

                // 只有当上风处比当前处高出一定阈值 (500m) 才视为阻挡
                if (elevationDiff > 30) {
                    // 1. 基础强度：落差越大，越干
                    let impact = elevationDiff / 30;
                    
                    // 2. 风速加成：风越大，焚风穿透力越强
                    // 限制最大加成倍数，防止数值爆炸
                    const windFactor = (vec.magnitude - 22);
                    impact *= windFactor;

                    // 3. [关键] 距离衰减：距离越远，影响越小
                    // 使用指数衰减公式：Impact * e^(-dist * decay)
                    // 当 dist=0.4时 衰减很少，当 dist=2.0时 衰减很多
                    impact *= Math.exp(-dist * decayFactor);

                    // 保留路径上发现的最强阻挡效果
                    if (impact > maxDryImpact) {
                        maxDryImpact = impact;
                    }
                }
            }

            // [安全钳制] 焚风最强让湿度下降 80%
            maxDryImpact = Math.min(maxDryImpact, 80);
            hum -= maxDryImpact;
        }
    }

    // 钳制背景湿度 (0% - 100%)
    return Math.max(5, Math.min(100, hum));
}

export function calculateTotalHumidity(lon, lat, pressureSystems, cyclone, globalTemp) {
    const currentMonth = (cyclone && cyclone.currentMonth) ? cyclone.currentMonth : 8;
    
    // 1. 获取基础背景湿度
    let hum = calculateBackgroundHumidity(lon, lat, pressureSystems, currentMonth, cyclone, globalTemp);

    // 2. 叠加气旋水汽 (核心 CDO + 螺旋雨带)
    // 逻辑复用自之前的 drawHumidityField
    if (cyclone && cyclone.status === 'active') {
        const dx = lon - cyclone.lon;
        const dy = lat - cyclone.lat;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        // A. 气旋核心强制加湿 (CDO)
        // 核心范围约为 环流大小 * 0.01 (度)
        if (dist < cyclone.circulationSize * 0.01) { 
            const stormHumBoost = 50 * (1 - dist/(cyclone.circulationSize * 0.01)); 
            hum += Math.max(0, stormHumBoost);
        }

        // B. 螺旋雨带 (简单的正弦波模拟)
        if (dist < cyclone.circulationSize * 0.02) {
            const angle = Math.atan2(dy, dx);
            const age = cyclone.age || 0;
            // 简单的螺旋纹理
            const spiral = Math.sin(angle * 3 + dist * 2 - age * 0.1);
            if (spiral > 0.5) hum += 10;
        }
    }

    // 钳制在 0-99 之间
    return Math.max(10, Math.min(99, hum));
}

// [修改] 绘制 850hPa 湿度场 (现在调用分离的逻辑)
export function drawHumidityField(container, mapProjection, pressureSystems, cyclone, globalTemp) {
    const svgNode = container.node().closest('svg'); 
    const { width, height } = svgNode.getBoundingClientRect();
    
    const nx = 56, ny = Math.round(nx * height / width);
    const grid = [];

    // 获取当前月份 (用于风场计算)
    const currentMonth = (cyclone && cyclone.currentMonth) ? cyclone.currentMonth : 8;

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) {
                grid.push(0); continue;
            }
            
            const finalHum = calculateTotalHumidity(coords[0], coords[1], pressureSystems, cyclone, globalTemp);
            grid.push(Math.max(10, Math.min(99, finalHum)));
        }
    }

    // 生成等值线
    const contours = d3.contours().size([nx, ny]).thresholds([10,20,30,40,50,60,70,80,90]);
    const transform = d3.geoTransform({ point: function(x, y) { this.stream.point(x * width / nx, y * height / ny); } });
    const pathGenerator = d3.geoPath().projection(transform);

    // 绘制
    container.selectAll("path")
        .data(contours(grid))
        .enter().append("path")
        .attr("d", pathGenerator)
        .attr("class", d => {
            if (d.value >= 90) return "isohume-high"; // 高湿区 (深绿/填充)
            if (d.value >= 60) return "isohume-med"; // 中湿区 (浅绿)
            if (d.value >= 30) return "isohume"; // 低湿区 (浅黄)
            return "isohume-low"; // 干线 (浅橙)
        });
}

function drawWindRadii(container, pathGenerator, cyclone, pressureSystems, isPaused) {
    const currentMonth = cyclone.currentMonth || 6;
    if (!cyclone || cyclone.intensity < 34) return;
// 定义要绘制的阈值
    const windData = [
        { threshold: 64, color: "#c0392b", active: cyclone.intensity >= 64, visualScale: 0.70 },
        { threshold: 50, color: "#e67e22", active: cyclone.intensity >= 50, visualScale: 0.85 },
        { threshold: 34, color: "#f1c40f", active: cyclone.intensity >= 34, visualScale: 1.00 }
    ];

// 搜索配置
    const SCAN_ANGLE_STEP = 10; // 扫描密度：每5度探测一次物理风速
    const DRAW_ARC_STEP = 10;    // 绘图密度：每5度画一个点(让圆弧更圆滑)
    const STEP_KM = 15;         // 射线步长
    const MAX_SEARCH_KM = 900;
    const SMOOTH_FACTOR = 0.5;
    const RMW_KM = 5 + cyclone.circulationSize * 0.15;
    if (!cyclone.radiiState) {
        cyclone.radiiState = {};
    }

    // 辅助：计算坐标
    const getPointAt = (centerLon, centerLat, angleRad, distKm) => {
        const distDeg = distKm / 111.32; 
        const lonScale = 1.0 / Math.max(0.1, Math.cos(centerLat * Math.PI / 180));
        const lon = centerLon + distDeg * Math.cos(angleRad) * lonScale;
        const lat = centerLat + distDeg * Math.sin(angleRad);
        return [lon, lat];
    };

// 辅助：物理探测
    const measureRadiusAtAngle = (angleRad, threshold) => {
        const [peakLon, peakLat] = getPointAt(cyclone.lon, cyclone.lat, angleRad, RMW_KM);
        const peakVec = getWindVectorAt(peakLon, peakLat, currentMonth, cyclone, pressureSystems);
        
        if (peakVec.magnitude < threshold) return 0; 

        let currentDist = RMW_KM;
        while (currentDist < MAX_SEARCH_KM) {
            const [sampleLon, sampleLat] = getPointAt(cyclone.lon, cyclone.lat, angleRad, currentDist);
            const vec = getWindVectorAt(sampleLon, sampleLat, currentMonth, cyclone, pressureSystems);
            if (vec.magnitude < threshold) return currentDist;
            currentDist += STEP_KM;
        }
        return currentDist;
    };

    const quadrants = [
        { id: 0, start: 0, end: 90 },   
        { id: 1, start: 90, end: 180 }, 
        { id: 2, start: 180, end: 270 },
        { id: 3, start: 270, end: 360 } 
    ];

    windData.forEach(level => {
        if (!level.active) return;
        
        if (!cyclone.radiiState[level.threshold]) {
            cyclone.radiiState[level.threshold] = [0, 0, 0, 0];
        }

        const polyPoints = [];
        let hasValidPoints = false;

        quadrants.forEach((quad, idx) => {
            let smoothedRadius = 0;
            const previousRadius = cyclone.radiiState[level.threshold][idx];

            if (isPaused && previousRadius > 0) {
                smoothedRadius = previousRadius;
            } else {
                let maxRadiusInQuad = 0;
                for (let angle = quad.start; angle <= quad.end; angle += SCAN_ANGLE_STEP) {
                    const angleRad = angle * (Math.PI / 180);
                    let r = measureRadiusAtAngle(angleRad, level.threshold);
                    r = r * level.visualScale;
                    if (r > maxRadiusInQuad) maxRadiusInQuad = r;
                }
                
                if (previousRadius === 0 && maxRadiusInQuad > 0) {
                    smoothedRadius = maxRadiusInQuad;
                } else {
                    smoothedRadius = previousRadius + (maxRadiusInQuad - previousRadius) * SMOOTH_FACTOR;
                }
                
                // 更新缓存
                cyclone.radiiState[level.threshold][idx] = smoothedRadius;
            }

            // 绘图
            if (smoothedRadius < 5) {
                const [cLon, cLat] = getPointAt(cyclone.lon, cyclone.lat, 0, 0);
                polyPoints.push([cLon, cLat]);
                return;
            }

            hasValidPoints = true;

            for (let angle = quad.start; angle <= quad.end; angle += DRAW_ARC_STEP) {
                const angleRad = angle * (Math.PI / 180);
                const [pLon, pLat] = getPointAt(cyclone.lon, cyclone.lat, angleRad, smoothedRadius);
                polyPoints.push([pLon, pLat]);
            }
        });

        if (hasValidPoints && polyPoints.length > 2) {
            polyPoints.push(polyPoints[0]);
            if (d3.polygonArea(polyPoints) < 0) polyPoints.reverse();

            const polygonGeoJSON = { type: "Polygon", coordinates: [polyPoints] };
            
            container.append("path")
                .datum(polygonGeoJSON)
                .attr("class", "wind-radii")
                .style("fill", level.color)
                .style("fill-rule", "evenodd")
                .style("stroke", d3.color(level.color).darker(0.5))
                .style("stroke-width", 0.8)
                .style("opacity", 0.4)
                .attr("d", pathGenerator);
        }
    });
}

let landCanvas = null;      // 陆地检测用的离屏 Canvas
let landCtx = null;
let windCanvasLayer = null; // 风场显示的 Canvas DOM 元素
let windCtx = null;         // 风场显示的绘图上下文
let landGrid = null;
let landGridWidth = 0;
let landGridHeight = 0;

function initLandGrid(world) {
    if (!world) return;
    
    // 网格精度：每度 8 个点 (0.125度精度)，足够风场使用了
    const resolution = 8; 
    landGridWidth = 360 * resolution;
    landGridHeight = 180 * resolution;
    
    // 创建离屏 Canvas 来通过绘图快速生成网格
    const canvas = document.createElement('canvas');
    canvas.width = landGridWidth;
    canvas.height = landGridHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // 使用等距圆柱投影将世界地图铺满 Canvas
    // x: -180~180 => 0~width
    // y: 90~-90   => 0~height
    const projection = d3.geoEquirectangular()
        .fitSize([landGridWidth, landGridHeight], world);
    const path = d3.geoPath().projection(projection).context(ctx);
    
    // 绘制陆地 (红色)
    ctx.fillStyle = '#FF0000';
    ctx.beginPath();
    path(world);
    ctx.fill();
    
    // 获取像素数据并保存为轻量级数组
    const imgData = ctx.getImageData(0, 0, landGridWidth, landGridHeight).data;
    landGrid = new Uint8Array(landGridWidth * landGridHeight);
    
    for (let i = 0; i < landGrid.length; i++) {
        // 如果像素有红色分量，标记为陆地 (1)
        // imgData 是 r,g,b,a 排列，红色是 index*4
        if (imgData[i * 4] > 100) {
            landGrid[i] = 1;
        }
    }
    
    console.log("Land grid initialized for high-performance wind rendering.");
}

// 辅助：快速查询某经纬度是否在陆地上
function checkLandFast(lon, lat) {
    if (!landGrid) return false;
    
    // 经纬度映射到网格索引
    // lon: -180 ~ 180 -> 0 ~ 360
    // lat: 90 ~ -90   -> 0 ~ 180 (注意 Canvas y轴向下)
    let x = Math.floor((lon + 180) * (landGridWidth / 360));
    let y = Math.floor((90 - lat) * (landGridHeight / 180));
    
    // 边界保护
    x = Math.max(0, Math.min(x, landGridWidth - 1));
    y = Math.max(0, Math.min(y, landGridHeight - 1));
    
    return landGrid[y * landGridWidth + x] === 1;
}

export function drawWindField(mapSvg, mapProjection, cyclone, pressureSystems, world) {
    const currentMonth = cyclone.currentMonth || 6;
    const { width, height } = mapSvg.node().getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!landGrid && world) {
        initLandGrid(world);
    }
    // --- 1. Canvas 初始化 (保持不变) ---
    if (!windCanvasLayer) {
        const container = mapSvg.node().parentNode;
        windCanvasLayer = document.createElement('canvas');
        windCanvasLayer.id = 'wind-canvas-layer';
        windCanvasLayer.style.position = 'absolute';
        windCanvasLayer.style.top = '0';
        windCanvasLayer.style.left = '0';
        windCanvasLayer.style.pointerEvents = 'none';
        windCanvasLayer.style.zIndex = '10';
        container.appendChild(windCanvasLayer);
        windCtx = windCanvasLayer.getContext('2d', { alpha: true });
    }

    const logicalWidth = windCanvasLayer.width / dpr;
    const logicalHeight = windCanvasLayer.height / dpr;

    if (logicalWidth !== width || logicalHeight !== height) {
        windCanvasLayer.width = width * dpr;
        windCanvasLayer.height = height * dpr;
        windCanvasLayer.style.width = `${width}px`;
        windCanvasLayer.style.height = `${height}px`;
        windCtx.scale(dpr, dpr);
    }
    
    windCtx.clearRect(0, 0, width, height);

    if (!world || !cyclone || cyclone.status !== 'active') return;

    // --- 3. 准备批量数组 ---
    // 我们将箭头分为三类颜色，分别存储坐标，最后统一画
    const batchLow = [];  // < 30kt (青色)
    const batchHigh = []; // > 30kt (红色)
    const batchExt = [];  // > 50kt (粉紫色)

    const GEO_RANGE = 20; 
    const GEO_STEP = 0.4; // [性能参数] 步长越大，点越少，FPS越高。建议 1.0 - 1.5
    const arrowScale = 0.75;
    const headLen = 5;

    const startLat = Math.floor(cyclone.lat - GEO_RANGE * 0.5);
    const endLat = Math.ceil(cyclone.lat + GEO_RANGE * 0.5);
    const startLon = Math.floor(cyclone.lon - GEO_RANGE);
    const endLon = Math.ceil(cyclone.lon + GEO_RANGE);

    // --- 4. 计算循环 (只计算，不绘图) ---
    for (let lat = startLat; lat <= endLat; lat += GEO_STEP) {
        if (lat < -90 || lat > 90) continue;

        for (let lon = startLon; lon <= endLon; lon += GEO_STEP) {
            
            // 投影
            const proj = mapProjection([lon, lat]);
            if (!proj || isNaN(proj[0]) || isNaN(proj[1])) continue;
            const [x, y] = proj;

            // 屏幕剔除
            if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

            // 物理计算
            let vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems);

            if (vec.magnitude <= 0) continue;

// --- [核心修改] 数学计算箭头坐标 ---
            const angle = Math.atan2(-vec.v, vec.u); 
            const len = Math.min(20, vec.magnitude * arrowScale);
            const halfLen = len / 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            // 1. 计算主干坐标
            const dx = halfLen * cos;
            const dy = halfLen * sin;
            const p1x = x - dx; const p1y = y - dy; // 起点
            const p2x = x + dx; const p2y = y + dy; // 终点 (箭头尖端)

            // 2. 计算箭头头部 "V" 字形的两个端点坐标
            // 我们需要从尖端往回折返一个角度
            const angleBack1 = angle + Math.PI * 0.85; // 约 153度
            const angleBack2 = angle - Math.PI * 0.85;
            
            let h1x = p2x, h1y = p2y, h2x = p2x, h2y = p2y;

            // 只有当线段足够长时才画箭头头，避免小风速看起来像杂点
            if (len > 6) {
                h1x = p2x + headLen * Math.cos(angleBack1);
                h1y = p2y + headLen * Math.sin(angleBack1);
                h2x = p2x + headLen * Math.cos(angleBack2);
                h2y = p2y + headLen * Math.sin(angleBack2);
            }

            // 3. 存入数组 (步长为 8)
            let targetBatch;
            if (vec.magnitude > 50) targetBatch = batchExt;
            else if (vec.magnitude > 30) targetBatch = batchHigh;
            else targetBatch = batchLow;

            targetBatch.push(p1x, p1y, p2x, p2y, h1x, h1y, h2x, h2y);
        }
    }

    // --- 5. 批量绘制 ---
    windCtx.lineWidth = 1.5; // 稍微调细一点，因为现在线条多了
    windCtx.lineCap = 'round';
    windCtx.lineJoin = 'round';

    const drawBatch = (batch, color) => {
        if (batch.length === 0) return;
        windCtx.beginPath();
        windCtx.strokeStyle = color;
        // 步长为 8 进行迭代
        for (let i = 0; i < batch.length; i += 8) {
            // 画主干
            windCtx.moveTo(batch[i], batch[i+1]);   // p1
            windCtx.lineTo(batch[i+2], batch[i+3]); // p2 (尖端)
            // 画箭头 V 字
            windCtx.moveTo(batch[i+4], batch[i+5]); // h1
            windCtx.lineTo(batch[i+2], batch[i+3]); // 回到 p2
            windCtx.lineTo(batch[i+6], batch[i+7]); // h2
        }
        windCtx.stroke();
    }

    drawBatch(batchLow, "rgba(34, 211, 238, 0.6)");
    drawBatch(batchHigh, "rgba(252, 165, 165, 0.7)");
    drawBatch(batchExt, "rgba(250, 120, 215, 0.8)");
}

function getUnwrappedPath(track) {
    if (!track || track.length === 0) return [];
    let lastLon = track[0][0];
    return track.map(point => {
        const p = [...point];
        p[0] = unwrapLongitude(p[0], lastLon); // 调用 utils 里的统一逻辑
        lastLon = p[0];
        return p;
    });
}

/**
 * 彻底重构的预报扇面渲染引擎 - 离散几何切片架构
 * 解决了日界线拉伸、路径交叉、末端畸变及渲染中断等所有核心问题
 */
export function drawForecastCone(container, mapProjection, pathForecasts) {
    if (!pathForecasts || pathForecasts.length === 0 || !pathForecasts[0].track || pathForecasts[0].track.length < 2) return;

    const forecastSteps = pathForecasts[0].track.length;
    const geoPath = d3.geoPath().projection(mapProjection);
    
    // 清理
    container.selectAll(".forecast-cone-container").remove();
    container.selectAll(".forecast-center-line").remove(); 

    const coneSegments = []; 
    const meanTrackCoordinates = []; // 用于构建 GeoJSON LineString
    let lastStepData = null;

    const unwrapLon = (lon, refLon) => {
        let diff = lon - refLon;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return refLon + diff;
    };
    // [步骤 0] 预计算：找到"完美截断点" (Quantized Cutoff)
    // 1. 找到该死的"实际消散点" (即强度 <= 15KT 的第一刻)
    let rawDeathIndex = forecastSteps;
    for (let i = 0; i < forecastSteps; i++) {
        const pointsAtStep = pathForecasts.map(f => f.track[i]);
        const avgInt = d3.mean(pointsAtStep, p => p[2]);
        if (avgInt <= 15) {
            rawDeathIndex = i;
            break;
        }
    }

    // 2. 将消散点"向下取整"到最近的标签关键帧
    // 关键帧定义：8(24h), 16(48h), 24(72h), 32(96h), 40(120h)
    // 步长为3小时，所以 8步=24小时
    const keyframes = [8, 16, 24];
    let quantizedLimit = 8; // 兜底：最少显示 24h (即索引8)

    // 遍历关键帧，找到能覆盖的最大关键帧
    for (let k of keyframes) {
        if (rawDeathIndex >= k) {
            quantizedLimit = k;
        } else {
            // 一旦当前的实际寿命达不到这个关键帧，就停止，保持在上一个关键帧
            break;
        }
    }

    // 如果实际数据本身就短（比如还没算到120h），防止越界
    quantizedLimit = Math.min(quantizedLimit, forecastSteps - 1);

    let refLon = pathForecasts[0].track[0][0]; 

    for (let i = 0; i <= quantizedLimit; i++) {
        const pointsAtStep = [];
        pathForecasts.forEach(f => {
            if (f.track[i]) pointsAtStep.push(f.track[i]);
        });
        if (pointsAtStep.length === 0) continue;

        // 1. [核心修复] 解包经度并计算平均值
        // 将所有点的经度转换为相对于 refLon 连续的值
        const unwrappedPoints = pointsAtStep.map(p => {
            const uLon = unwrapLon(p[0], refLon);
            return [uLon, p[1]]; // [lon, lat]
        });

        const avgLonUnwrapped = d3.mean(unwrappedPoints, p => p[0]);
        const avgLat = d3.mean(pointsAtStep, p => p[1]);

        // 更新下一轮的参考经度
        refLon = avgLonUnwrapped;

        // 规范化 avgLon 回 -180~180 用于存储 GeoJSON (虽然 D3 通常能处理越界，但规范化更安全)
        let avgLonNorm = avgLonUnwrapped;
        while (avgLonNorm > 180) avgLonNorm -= 360;
        while (avgLonNorm < -180) avgLonNorm += 360;

        // 收集中心线点 (使用规范化坐标)
        meanTrackCoordinates.push([avgLonNorm, avgLat]);

        // 2. 动态半径 (使用解包后的坐标计算距离，避免日界线处距离突变)
        const stdDev = d3.deviation(unwrappedPoints, p => Math.hypot(p[0] - avgLonUnwrapped, p[1] - avgLat)) || 0;
        const radiusDeg = (0.25 + i * 0.14) + (stdDev * 0.6);
        const cosL = Math.cos(avgLat * Math.PI / 180);

        // 切线方向
        let angle = 0;
        if (i < quantizedLimit) {
            const nextPoints = [];
            pathForecasts.forEach(f => { if(f.track[i+1]) nextPoints.push(f.track[i+1]); });
            if (nextPoints.length > 0) {
                // 计算下一个点的平均位置 (同样需要解包)
                const nextUnwrapped = nextPoints.map(p => [unwrapLon(p[0], refLon), p[1]]);
                const nextLonU = d3.mean(nextUnwrapped, p => p[0]);
                const nextLat = d3.mean(nextPoints, p => p[1]);
                
                // 直接用解包后的差值计算角度
                const dLon = nextLonU - avgLonUnwrapped;
                angle = Math.atan2(nextLat - avgLat, dLon * cosL);
            }
        } else if (lastStepData) {
            // 回溯上一个点 (lastStepData.rawCenter 存储了解包后的坐标)
            const dLon = avgLonUnwrapped - lastStepData.rawCenter[0];
            angle = Math.atan2(avgLat - lastStepData.rawCenter[1], dLon * cosL);
        }

        const normal = angle + Math.PI / 2;
        
        // 构建锥体数据
        let leftLon = avgLonUnwrapped + (radiusDeg * Math.cos(normal) / cosL);
        let leftLat = avgLat + (radiusDeg * Math.sin(normal));
        let rightLon = avgLonUnwrapped + (radiusDeg * Math.cos(normal + Math.PI) / cosL);
        let rightLat = avgLat + (radiusDeg * Math.sin(normal + Math.PI));
        // 规范化边界点
        const normalize = (lon) => {
            while (lon > 180) lon -= 360;
            while (lon < -180) lon += 360;
            return lon;
        };

        const currentStep = {
            rawCenter: [avgLonUnwrapped, avgLat], // 存一下未解包的用于下一次角度计算
            center: [avgLonNorm, avgLat],
            left: [normalize(leftLon), leftLat],
            right: [normalize(rightLon), rightLat],
            radiusDeg: radiusDeg
        };

        if (lastStepData) {
            // 检测跨越：如果左右边界跨度过大，可能需要切割 (D3 GeoJSON 会自动处理大部分)
            // 这里直接推入 Polygon，相信 d3.geoPath 的切割能力
            coneSegments.push({
                type: "Feature",
                geometry: {
                    type: "Polygon",
                    coordinates: [[lastStepData.left, currentStep.left, currentStep.right, lastStepData.right, lastStepData.left]]
                }
            });
        }
        
        const nodeCircle = createGeoCircle(currentStep.center[0], currentStep.center[1], radiusDeg * 111.32);
        coneSegments.push({ type: "Feature", geometry: nodeCircle });

        lastStepData = currentStep;
    }

    // --- 第二阶段：绘制锥体 ---
    let svg = d3.select(container.node().nearestViewportElement);
    if (svg.select("#cone-merge-filter").empty()) {
        svg.append("defs").append("filter").attr("id", "cone-merge-filter").append("feComponentTransfer").append("feFuncA").attr("type", "discrete").attr("tableValues", "0 1"); 
    }

    const coneGroup = container.append("g")
        .attr("class", "forecast-cone-container")
        .attr("filter", "url(#cone-merge-filter)")
        .style("opacity", 0.15); 

    coneGroup.selectAll("path")
        .data(coneSegments)
        .enter().append("path")
        .attr("d", geoPath)
        .style("fill", "rgb(85, 105, 160)") 
        .style("stroke", "none")
        .style("pointer-events", "none");

    // --- 第三阶段：绘制中心线 ---
    // 由于循环严格控制在 quantizedLimit，这里的 centerLinePoints 也是完美的
    if (meanTrackCoordinates.length > 1) {
        container.append("path")
            .datum({
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: meanTrackCoordinates
                }
            })
            .attr("class", "forecast-center-line")
            .attr("d", geoPath) 
            .style("fill", "none")
            .style("stroke", "cyan")
            .style("stroke-width", 2)
            .style("stroke-dasharray", "4, 3")
            .style("opacity", 0.8)
            .style("pointer-events", "none");
    }

    // --- 第四阶段：绘制标签 ---
    // 只绘制处于 quantizedLimit 之内的标签
    const labelsToDraw = [8, 16, 24]; 
    labelsToDraw.forEach(idx => {
        // [核心修改] 如果这个标签索引超过了我们的完美截断点，直接不画
        // 这样线停在哪里，最后一个标签就在哪里
        if (idx > quantizedLimit) return;
        
        const step = pathForecasts[0].track[idx];
        const forecastHour = idx * 3;
        
        if (step) {
            const proj = mapProjection([step[0], step[1]]);
            if (proj) {
                container.append("circle")
                    .attr("cx", proj[0]).attr("cy", proj[1]).attr("r", 3).attr("fill", "white");
                container.append("text")
                    .attr("x", proj[0]).attr("y", proj[1] - 7)
                    .attr("text-anchor", "middle")
                    .style("font-size", "10px")
                    .style("font-family", "Monospace")
                    .style("fill", "white")
                    .style("text-shadow", "0 1px 2px black")
                    .text(`+${forecastHour}h`);
            }
        }
    });
}

function drawPressureField(container, mapProjection, pressureSystemsObj) {
    const svgNode = container.node().closest('svg'); 
    const { width, height } = svgNode.getBoundingClientRect();
    const nx = 80, ny = Math.round(nx * height / width), grid = [];
    
    // [关键修复] 提取低层系统用于绘图
    // 如果是新版对象结构，取 .lower；如果是旧版数组，直接使用
    const systemsLayer = Array.isArray(pressureSystemsObj) ? pressureSystemsObj : (pressureSystemsObj.lower || []);

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) {
                grid.push(1012); continue;
            }
            
            // [关键修复] 传入正确的层级数组
            // getPressureAt 现在接收 systemsLayer (数组)
            grid.push(getPressureAt(coords[0], coords[1], systemsLayer));
        }
    }
    
    const contours = d3.contours().size([nx, ny]).thresholds(d3.range(990, 1050, 2));
    const transform = d3.geoTransform({ point: function(x, y) { this.stream.point(x * width / nx, y * height / ny); } });
    const pathGenerator = d3.geoPath().projection(transform);
    
    container.append("g").selectAll("path").data(contours(grid)).enter().append("path")
        .attr("class", d => d.value > 1012 ? "isobar" : "isobar-low")
        .attr("d", pathGenerator);
}

export function drawMap(mapSvg, mapProjection, world, cyclone, options = {}) {
    if (!world || !mapSvg) return;

    // 1. 使用对象解构并设置默认值，消除长参数列表带来的维护麻烦
    const {
        pathForecasts = [],
        pressureSystems = [],
        showPressureField = false,
        showHumidityField = false,
        showPathForecast = false,
        showWindRadii = false,
        showPathPoints = false,
        showWindField = false,
        siteName = null,
        siteLon = null,
        siteLat = null,
        siteData = null,
        siteHistory = [],
        onSiteClick = null,
        isPaused = false,
        month = 8
    } = options;

    // 2. 初始化图层结构 (逻辑保持不变，但结构更清晰)
    const layerNames = [
        "layer-static",       // 背景：经纬网、陆地
        "layer-humidity",     // 等湿度线
        "layer-pressure",     // 等压线
        "layer-forecast",     // 预测路径/锥
        "layer-track-lines",  // 历史路径线
        "layer-track-points", // 历史路径点
        "layer-wind-radii",   // 风圈
        "layer-cyclone",      // 当前气旋图标
        "layer-pressure-handles",   // 压力系统控制手柄层
        "track-interaction-layer",
        "layer-ui"            // 站点标记、悬浮框等
    ];

    layerNames.forEach(name => {
        const className = `${name}`;
        if (mapSvg.select(`.${className}`).empty()) {
            mapSvg.append("g").attr("class", className);
        }
    });
    const staticLayer = mapSvg.select(".layer-static");
    const pressureLayer = mapSvg.select(".layer-pressure");
    const humidityLayer = mapSvg.select(".layer-humidity");
    const forecastLayer = mapSvg.select(".layer-forecast");
    const trackLineLayer = mapSvg.select(".layer-track-lines");
    const trackPointLayer = mapSvg.select(".layer-track-points");
    const windRadiiLayer = mapSvg.select(".layer-wind-radii");
    const cycloneLayer = mapSvg.select(".layer-cyclone");
    const uiLayer = mapSvg.select(".layer-ui");
    const pressureHandlesLayer = mapSvg.select(".layer-pressure-handles");

    const { width, height } = mapSvg.node().getBoundingClientRect();
    const pathGenerator = d3.geoPath().projection(mapProjection);

    // 3. 气旋中心定位逻辑 (仅在 active 状态且有坐标时执行)
    if (cyclone && cyclone.status === 'active' && isFinite(cyclone.lon)) {
        mapProjection.center([cyclone.lon, cyclone.lat]).translate([width / 2, height / 2]);
    }

    // ============================================================
    // 3. [修复核心] 静态背景绘制逻辑
    // ============================================================
    
    // A. 初始化：如果陆地不存在，则创建 DOM (仅执行一次)
    if (staticLayer.select(".land").empty()) {
        // 绘制经纬网容器
        staticLayer.append("path")
            .datum(d3.geoGraticule().step([10, 10]))
            .attr("class", "graticule");

        // 绘制陆地容器
        staticLayer.append("g")
            .attr("class", "land-group") //以此 Group 为容器
            .selectAll("path")
            .data(world.features)
            .enter().append("path")
            .attr("class", "land")
            .style("stroke", "none");
    }

    // B. 更新：每一帧都需要根据新的 Projection 更新坐标
    // 虽然有些消耗，但比 remove() + append() 快得多
    staticLayer.select(".graticule").attr("d", pathGenerator);
    staticLayer.select(".land-group").selectAll(".land").attr("d", pathGenerator);

    // ============================================================

    // 4. 风场 (Canvas) - 独立层，无需改动
    if (showWindField && cyclone && cyclone.status === 'active') {
        drawWindField(mapSvg, mapProjection, cyclone, pressureSystems, world);
    } else {
        if (typeof windCtx !== 'undefined' && windCtx && typeof windCanvasLayer !== 'undefined' && windCanvasLayer) {
            windCtx.clearRect(0, 0, windCanvasLayer.width, windCanvasLayer.height);
        }
    }

    // 5. 气压场 (Pressure)和湿度场 (Humidity)
    pressureLayer.selectAll("*").remove(); 
    if (showPressureField && cyclone && cyclone.status === 'active') {
        drawPressureField(pressureLayer, mapProjection, pressureSystems);
    }

    humidityLayer.selectAll("*").remove();
    if (showHumidityField && cyclone && cyclone.status === 'active') {
        drawHumidityField(humidityLayer, mapProjection, pressureSystems, cyclone);
    }

    // 6. 风圈 (Wind Radii)
    windRadiiLayer.selectAll("*").remove(); 
    if (showWindRadii && cyclone && cyclone.status === 'active') {
        drawWindRadii(windRadiiLayer, pathGenerator, cyclone, pressureSystems, isPaused);
    }

    // 7. 预测路径 (Forecast)
    forecastLayer.selectAll("*").remove();
    if (showPathForecast && pathForecasts && pathForecasts.length > 0) {
        drawForecastCone(forecastLayer, mapProjection, pathForecasts);
        const colors = d3.scaleOrdinal(d3.schemeCategory10);
    }

    // 8. 历史路径 (Track) - 增量更新模式
    if (cyclone && cyclone.track && cyclone.track.length > 1) {
        // 数据解包
        const unwrappedTrack = [];
        let lastLon = NaN;
        cyclone.track.forEach(pointData => {
            const point = [...pointData];
            let lon = point[0];
            if (!isNaN(lastLon)) {
                if (Math.abs(lon - lastLon) > 180) {
                    lon += (lon < lastLon) ? 360 : -360;
                }
            }
            point[0] = lon;
            lastLon = lon;
            unwrappedTrack.push(point);
        });

        const segmentData = [];
        for (let i = 0; i < unwrappedTrack.length - 1; i++) {
            segmentData.push({
                type: "LineString",
                coordinates: [unwrappedTrack[i].slice(0, 2), unwrappedTrack[i+1].slice(0, 2)],
                intensity: unwrappedTrack[i+1][2],
                isT: unwrappedTrack[i+1][3],
                isE: unwrappedTrack[i+1][4],
                isS: unwrappedTrack[i+1][6]
            });
        }

        // 绘制线段
        trackLineLayer.selectAll(".storm-track")
            .data(segmentData)
            .join(
                // Enter: 创建新元素时设置颜色
                enter => enter.append("path")
                    .attr("class", "storm-track")
                    .attr("d", pathGenerator)
                    .style("stroke", d => getCategory(d.intensity, d.isT, d.isE, d.isS).color),
                
                // Update: [核心修复] 更新现有元素时，必须同时更新形状 AND 颜色
                // 否则复用的 DOM 会保留上一次模拟的颜色
                update => update
                    .attr("d", pathGenerator)
                    .style("stroke", d => getCategory(d.intensity, d.isT, d.isE, d.isS).color)
            );

        // 绘制节点 (同理，更新 update 逻辑)
        if (showPathPoints) {
            const pointDisplayData = unwrappedTrack.filter((_, i) => i % 2 === 0);
            trackPointLayer.selectAll("circle")
                .data(pointDisplayData)
                .join(
                    enter => enter.append("circle")
                        .attr("r", 4.5)
                        .attr("stroke", "#222222")
                        .attr("stroke-width", 1)
                        .attr("cx", d => mapProjection(d.slice(0, 2))[0])
                        .attr("cy", d => mapProjection(d.slice(0, 2))[1])
                        .style("fill", d => getCategory(d[2], d[3], d[4], d[6]).color),
                    
                    // [核心修复] Update 时也要更新位置 AND 颜色
                    update => update
                        .attr("cx", d => mapProjection(d.slice(0, 2))[0])
                        .attr("cy", d => mapProjection(d.slice(0, 2))[1])
                        .style("fill", d => getCategory(d[2], d[3], d[4], d[6]).color)
                );
        } else {
            trackPointLayer.selectAll("*").remove();
        }
    } else {
        trackLineLayer.selectAll("*").remove();
        trackPointLayer.selectAll("*").remove();
    }

    // 9. 当前气旋图标 (Icon)
    if (cyclone && cyclone.status === 'active') {
        const iconData = [cyclone];
        cycloneLayer.selectAll("circle")
            .data(iconData)
            .join(
                enter => enter.append("circle")
                    .attr("r", 7)
                    .attr("stroke", "white")
                    .attr("stroke-width", 1.5)
                    .attr("cx", d => mapProjection([d.lon, d.lat])[0])
                    .attr("cy", d => mapProjection([d.lon, d.lat])[1])
                    .attr("fill", d => getCategory(d.intensity, d.isTransitioning, d.isExtratropical, d.isSubtropical).color),
                update => update
                    .attr("cx", d => mapProjection([d.lon, d.lat])[0])
                    .attr("cy", d => mapProjection([d.lon, d.lat])[1])
                    .attr("fill", d => getCategory(d.intensity, d.isTransitioning, d.isExtratropical, d.isSubtropical).color)
                    .style("border-radius", "50%")
                    .attr("class", d => {
                        const isExtreme = d.intensity >= 96 && !d.isExtratropical;
                        return isExtreme ? "extreme-intensity-glow" : "";
                    })
            );
    } else {
        cycloneLayer.selectAll("*").remove();
    }

    pressureHandlesLayer.selectAll("*").remove(); 
    
    const activeSystemsList = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems.upper || []);

    if (showPressureField && cyclone && cyclone.status === 'active' && activeSystemsList.length > 0) {
        // 过滤出强度显著的系统用于显示手柄
        const significantSystems = activeSystemsList.filter(s => Math.abs(s.strength) > 5);
        
        // 第3个参数传过滤后的列表，第4个参数传完整的 pressureSystems 对象(用于同步拖动)
        drawInteractivePressureSystems(pressureHandlesLayer, mapProjection, significantSystems, pressureSystems, cyclone, options.onSystemRemove);
    }

    // 10. UI 层
    uiLayer.selectAll("*").remove();
    if (siteLon != null && siteLat != null && isFinite(siteLon) && isFinite(siteLat)) {
        drawSiteMarker(uiLayer, mapProjection, siteName, siteLon, siteLat, siteData, siteHistory, onSiteClick);
    }
}

// 辅助函数：绘制站点标记 (精简版 - 移除旧图表逻辑)
function drawSiteMarker(container, projection, name, lon, lat, data, history, onClick) {
    const proj = projection([lon, lat]);
    if (!proj) return;
    const [siteX, siteY] = proj;
    const isSelected = data ? data.isSelected : false;
    
    // 选中时稍微亮一点，但不弹出东西
    const markerColor = isSelected ? "rgba(255, 255, 255, 0.8)" : "rgba(17, 24, 39, 0.5)";

    // 1. 绘制站点方块
    container.append("rect")
        .attr("x", siteX - 5).attr("y", siteY - 5)
        .attr("width", 10).attr("height", 10)
        .attr("fill", markerColor)
        .attr("stroke", "white").attr("stroke-width", 1.5)
        .style("cursor", "pointer")
        .style("pointer-events", "all") 
        .on('mouseover', function() { 
            d3.select(this).attr('fill', "rgba(255, 255, 255, 1.0)");
            // 隐藏其他图层的干扰
            d3.select(".tooltip").style("opacity", 0);
            d3.selectAll(".track-interaction-layer circle").style("opacity", 0);
        })
        .on('mousemove', (e) => e.stopPropagation()) 
        .on('mouseout', function() { d3.select(this).attr('fill', markerColor) })
        .on("click", (e) => { e.stopPropagation(); if (onClick) onClick(); });

    // 2. 绘制站点名称
    if (name) {
        container.append("text")
            .attr("x", siteX).attr("y", siteY + 16)
            .attr("class", "site-label-name")
            .style("fill", "white").style("font-weight", "bold").style("font-size", "11px")
            .style("text-anchor", "middle").style("stroke", "black").style("stroke-width", "2px")
            .style("paint-order", "stroke").text(name);
    }

    // 3. 绘制基础风速标签 (常驻显示)
    if (data && data.label) {
        let windColor = "#22d3ee"; 
        const spd = data.displaySpeed || 0;

        if (spd >= 64) { windColor = "#ff80ab"; } 
        else if (spd >= 48) { windColor = "#d500f9"; } 
        else if (spd >= 34) { windColor = "#ef4444"; } 
        else if (spd >= 22) { windColor = "#facc15"; }

        container.append("foreignObject")
            .attr("x", siteX - 60) 
            .attr("y", siteY - 22) 
            .attr("width", 120)
            .attr("height", 20)
            .style("pointer-events", "none") 
            .append("xhtml:div")
            .style("width", "100%")
            .style("height", "100%")
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center")
            .style("text-align", "center")
            .style("font-family", "Monospace")
            .style("font-size", "10px")
            .style("font-weight", "bold")
            .style("color", windColor)
            .style("text-shadow", "0 0 2px black, 0 0 4px black") 
            .html(data.label);
    }

    // [已删除] 旧的气压显示逻辑
    // [已删除] 旧的折线图绘制逻辑 (drawSiteChart 调用)
}

export function drawFinalPath(mapSvg, mapProjection, cyclone, world, tooltip, siteName, siteLon, siteLat, showPathPoints = false, finalStats = null, basin = 'WPAC', pressureSystems = [], showWindField = false, month = 8, siteHistory = [], siteData = null, onSiteClick = null) {
    // 1. 基础安全检查
    if (!cyclone || !cyclone.track || cyclone.track.length < 2) return;
    
    // [修复 A] 清理 "SHOW ALL" 模式留下的残留线条 (.history-segment)
    mapSvg.select(".layer-track-lines").selectAll(".history-segment").remove();

    const { width, height } = mapSvg.node().getBoundingClientRect();

    // 2. 经度解包 (处理日界线)
    const unwrappedTrackForCentering = [];
    let lastLon_center = NaN;
    cyclone.track.forEach(pointData => {
        const point = [...pointData];
        let lon = point[0];
        if (!isNaN(lastLon_center)) {
            if (Math.abs(lon - lastLon_center) > 180) {
                lon += (lon < lastLon_center) ? 360 : -360;
            }
        }
        point[0] = lon;
        lastLon_center = lon;
        unwrappedTrackForCentering.push(point);
    });

    // 3. 计算中心并旋转地球
    const avgLon = d3.mean(unwrappedTrackForCentering, p => p[0]);
    const avgLat = d3.mean(unwrappedTrackForCentering, p => p[1]);

    if (isFinite(avgLon) && isFinite(avgLat)) {
        // 将视角旋转到路径中心
        mapProjection.rotate([-avgLon, -avgLat]).center([0, 0]);
    }

    // 4. 计算缩放 (Fit Extent)
    const coords = cyclone.track.map(p => [p[0], p[1]]);
    const fullTrackGeoJSON = { type: "LineString", coordinates: coords };

    // [修复 B] 动态计算边距，防止硬编码数值在小屏幕上导致负数
    // 左侧留出 360px 给左侧面板 (如果有显示)，上下留出 50px
    const leftPad = width > 600 ? 360 : 100; 
    
    // 自动缩放地图以适应完整路径
    mapProjection.fitExtent([[leftPad, 100], [width - 100, height - 100]], fullTrackGeoJSON);
    
    // [修复 C - 核心] 创建副本并强制修改状态为 'history'
    // 这防止 drawMap() 内部检测到 'active' 状态后强制重置地图中心，覆盖上面的 fitExtent
    const cycloneForDisplay = { ...cyclone, status: 'history' };

    // 5. 绘制地图
    drawMap(mapSvg, mapProjection, world, cycloneForDisplay, {
    pathForecasts: [],
    pressureSystems: pressureSystems,
    showPressureField: false,
    showHumidityField: false,
    showPathForecast: false,
    showWindRadii: false,
    siteName,
    siteLon,
    siteLat,
    showPathPoints,
    showWindField,
    month,
    siteHistory,
    siteData,
    onSiteClick
    });

    // 6. 更新信息显示
    if (finalStats) {
        const infoBox = document.getElementById('map-info-box');
        const timeEl = document.getElementById('map-info-time');
        const intensityEl = document.getElementById('map-info-intensity');
        const movementEl = document.getElementById('map-info-movement');

        if (infoBox && timeEl && intensityEl && movementEl) {
            timeEl.textContent = finalStats.number; 
            intensityEl.textContent = `${finalStats.peakWind}kt / ${finalStats.minPressure}hPa`;
            movementEl.textContent = `ACE: ${finalStats.ace}`;
            infoBox.classList.remove('hidden');
        }
    } else {
         document.getElementById('map-info-box').classList.add('hidden');
    }

// 7. 交互层 (Interaction Layer) - 鼠标悬停查看详情 + 点击查看历史预测
    let interactionLayer = mapSvg.select(".track-interaction-layer");
    let forecastLayer = mapSvg.select(".layer-forecast"); // 确保获取到预测层

    // 如果预测层不存在，创建一个（通常 drawMap 会创建，为了保险起见）
    if (forecastLayer.empty()) {
        forecastLayer = mapSvg.insert("g", ".layer-ui").attr("class", "layer-forecast");
    }
    
    if (interactionLayer.empty()) {
        const uiLayer = mapSvg.select(".layer-ui");
        if (!uiLayer.empty()) {
            interactionLayer = mapSvg.insert("g", ".layer-ui").attr("class", "track-interaction-layer");
        } else {
            interactionLayer = mapSvg.append("g").attr("class", "track-interaction-layer");
        }
    }

    // 重建遮罩
    interactionLayer.selectAll("*").remove();

    interactionLayer.append("rect")
        .attr("class", "interaction-overlay")
        .attr("width", width)
        .attr("height", height)
        .style("fill", "transparent") // 关键：必须是 transparent 用于接收鼠标事件
        .style("cursor", "crosshair");

    // 悬停时的高亮圆圈
    const highlightCircle = interactionLayer.append("circle")
        .attr("class", "highlight-circle")
        .attr("r", 9)
        .style("fill", "none")
        .style("stroke", "white")
        .style("stroke-width", "2px")
        .style("pointer-events", "none")
        .style("opacity", 0);

    // 点击锁定时的圆圈 (新增：用于标记当前选中的点)
    const selectedCircle = interactionLayer.append("circle")
        .attr("class", "selected-circle")
        .attr("r", 7)
        .style("fill", "cyan") // 选中点用青色实心
        .style("fill-opacity", 0.6)
        .style("stroke", "none")
        .style("pointer-events", "none")
        .style("opacity", 0);

    // 辅助函数：寻找最近点
    function findClosestPoint(mouseX, mouseY) {
        let closest = null;
        let minDist = Infinity;

        cyclone.track.forEach((pointData, idx) => {
            const proj = mapProjection(pointData.slice(0, 2));
            if (!proj) return;
            const [projX, projY] = proj;
            const dist = Math.sqrt((mouseX - projX) ** 2 + (mouseY - projY) ** 2);
            if (dist < minDist) {
                minDist = dist;
                closest = { data: pointData, index: idx };
            }
        });
        
        // 阈值判断 (50px)
        if (minDist < 50) return closest;
        return null;
    }

    // 绑定事件
    interactionLayer.select(".interaction-overlay")
        .on("mousemove", function(event) {
            const [mouseX, mouseY] = d3.pointer(event);
            const closestPoint = findClosestPoint(mouseX, mouseY);

            if (closestPoint) {
                const { data, index } = closestPoint;
                const [lon, lat, intensity, isT, isE, circulationSize, isS, r34, r50, r64, storedPressure] = data;
                
                // --- Tooltip 显示逻辑 ---
                const category = getCategory(intensity, isT, isE, isS);
                let pressure;
                if (storedPressure !== undefined && storedPressure !== null) {
                    pressure = storedPressure;
                } else {
                    const validSize = (typeof circulationSize === 'number') ? circulationSize : 250;
                    const centerEnvP = getPressureAt(lon, lat, pressureSystems);
                    pressure = Math.round(windToPressure(intensity, validSize, basin, centerEnvP));
                }

                const latStr = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
                const lonValue = lon > 180 ? lon - 360 : (lon < -180 ? lon + 360 : lon);
                const lonStr = `${Math.abs(lonValue).toFixed(1)}°${lonValue >= 0 ? 'E' : 'W'}`;
                
                tooltip.transition().duration(50).style("opacity", .9);
                tooltip.html(
                    `<div style="text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 11px;">
                        <strong style="color: #94a3b8;">T+${index * 3}h</strong><br/>
                        <span style="color: #cbd5e1;">${latStr} ${lonStr}</span><br/>
                        <span style="color:${category.color}; font-size:1.1em; font-weight:bold;">
                        ${intensity.toFixed(0)}KT / ${pressure}hPa
                        </span><br/>
                        <span style="color: #64748b; font-size: 10px; text-transform: uppercase;">${category.shortName}</span>
                    </div>`
                )
                .style("left", (event.pageX + 15) + "px")
                .style("top", (event.pageY - 28) + "px");
                
                // --- 高亮圆圈位置更新 ---
                const proj = mapProjection(data.slice(0, 2));
                if (proj) {
                    highlightCircle
                        .attr("cx", proj[0])
                        .attr("cy", proj[1])
                        .style("fill", category.color) // 使用当前等级颜色
                        .style("opacity", 1);
                }
            } else {
                tooltip.style("opacity", 0);
                highlightCircle.style("opacity", 0);
            }
        })
        .on("click", function(event) {
            // [核心修改] 点击事件：处理历史预测的显示与隐藏
            const [mouseX, mouseY] = d3.pointer(event);
            const closestPoint = findClosestPoint(mouseX, mouseY);

            // 1. 无论点没点中，先清空旧的预测线和选中圆圈
            forecastLayer.selectAll("*").remove();
            selectedCircle.style("opacity", 0);

            if (closestPoint) {
                const { data, index } = closestPoint;
                
                // 标记选中的点
                const proj = mapProjection(data.slice(0, 2));
                selectedCircle
                    .attr("cx", proj[0])
                    .attr("cy", proj[1])
                    .style("opacity", 1);

                // 2. 获取对应的历史时刻
                // 假设每步是3小时，气象预报通常每6小时存储一次
                const currentAge = index * 3; 
                const snapAge = Math.floor(currentAge / 6) * 6; // 向下取整到最近的6小时节点

                // 3. 查找并绘制预测
                if (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) {
                    const historicalForecast = cyclone.forecastLogs[snapAge];
                    
                    console.log(`Displaying forecast for T+${snapAge}h`); // 调试用

                    // 绘制预测锥 (使用现有的 drawForecastCone 函数)
                    if (typeof drawForecastCone === 'function') {
                        drawForecastCone(forecastLayer, mapProjection, historicalForecast);
                    }

                    // 绘制预测中心线
                    const colors = d3.scaleOrdinal(d3.schemeCategory10);
                    const pathGenerator = d3.geoPath().projection(mapProjection);
                    
                    historicalForecast.forEach((forecast, i) => {
                        const forecastGeoJSON = { type: "LineString", coordinates: forecast.track };
                        drawForecastCone(forecastLayer, mapProjection, cyclone.pathForecasts);
                        // 可选：添加模型名称标签
                        if (forecast.track.length > 0) {
                             const lastPoint = forecast.track[forecast.track.length - 1];
                             const projPos = mapProjection(lastPoint);
                             if (projPos) {
                                 forecastLayer.append("text")
                                    .attr("x", projPos[0] + 5)
                                    .attr("y", projPos[1])
                                    .text(forecast.modelName || "")
                                    .attr("class", "forecast-point-label")
                                    .style("opacity", 0.7);
                             }
                        }
                    });
                } else {
                    // 如果该时刻没有预测数据，可以稍微提示一下或者不做操作
                    console.log(`No forecast data for T+${snapAge}h`);
                }
                const trackClickEvent = new CustomEvent('cycloneTrackClick', { 
                    detail: { index: index } 
                });
                window.dispatchEvent(trackClickEvent);
            } else {
                const deselectEvent = new CustomEvent('cycloneTrackDeselect');
                window.dispatchEvent(deselectEvent);
            }
        })
        .on("mouseleave", function() {
            tooltip.style("opacity", 0);
            highlightCircle.style("opacity", 0);
        });
}

export function drawHistoricalIntensityChart(chartContainer, cycloneTrack, tooltip, mode = 'kt', basin = 'WPAC') {
    chartContainer.selectAll("*").remove();
    if (!cycloneTrack || cycloneTrack.length < 2) return;

    const { width, height } = chartContainer.node().getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const margin = {top: 20, right: 20, bottom: 30, left: 45};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    
    const chartSvg = chartContainer.append("svg").attr("width", width).attr("height", height)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    
    // 1. 处理数据：计算气压或保持风速
    const intensityData = cycloneTrack.map((point, index) => {
        const intensity = Math.round(point[2]);
        let pressure;
        if (point[10] !== undefined && point[10] !== null) {
            pressure = point[10];
        } else {
            const size = point[5] || 300;
            // 注意：这里因为拿不到历史环境场，只能用默认环境压进行估算（会有偏差，但没办法）
            pressure = Math.round(windToPressure(intensity, size, basin));
        }
        
        return {
            hour: index * 3,
            val: mode === 'kt' ? intensity : pressure, // 根据模式选择数值
            isT: point[3],
            isE: point[4],
            isS: point[6]
        };
    });

    const maxHour = intensityData[intensityData.length - 1].hour;

    // 2. 比例尺 (Scale) 适配
    const x = d3.scaleLinear().domain([0, maxHour]).range([0, innerWidth]);
    let y;

    if (mode === 'kt') {
        const maxIntensity = d3.max(intensityData, d => d.val);
        y = d3.scaleLinear().domain([0, Math.max(30, maxIntensity * 1.05)]).range([innerHeight, 0]).nice();
    } else {
        const minP = d3.min(intensityData, d => d.val);
        // 气压图：上方是高压 (1015hPa)，下方是低压 (强台风)
        y = d3.scaleLinear().domain([Math.min(1000, minP - 5), 1015]).range([innerHeight, 0]).nice();
    }
    
    // 3. 坐标轴
    chartSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(x).ticks(Math.min(5, maxHour / 12)).tickFormat(d => `${d}h`));
    chartSvg.append("g").attr("class", "axis")
        .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}${mode === 'kt' ? 'kt' : ''}`));

    // 4. 背景色带：仅在 KT 模式下显示强度等级
    if (mode === 'kt') {
        const categoryBands = [
            { limit: 24, color: "#aaaaaa" }, { limit: 34, color: "#5dade2" }, { limit: 64, color: "#2ecc71" },
            { limit: 83, color: "#f1c40f" }, { limit: 96, color: "#f39c12" },
            { limit: 113, color: "#e67e22" }, { limit: 137, color: "#d35400" },
            { limit: 170, color: "#c0392b" }
        ];
        let lastY = y(0);
        categoryBands.forEach(band => {
            const yVal = y(band.limit);
            chartSvg.append("rect").attr("x", 0).attr("y", yVal).attr("width", innerWidth).attr("height", Math.max(0, lastY - yVal))
                .attr("fill", band.color).attr("opacity", 0.15);
            lastY = yVal;
        });
    }

    // 5. 绘制曲线
    const lineGen = d3.line().x(d => x(d.hour)).y(d => y(d.val));
    
    // 底线
    chartSvg.append("path").datum(intensityData).attr("fill", "none").attr("stroke", "white").attr("stroke-width", 2).attr("d", lineGen);

    // 温带气旋覆盖线 (紫色)
    const extLineGen = d3.line().x(d => x(d.hour)).y(d => y(d.val)).defined(d => d.isE);
    chartSvg.append("path").datum(intensityData).attr("fill", "none").attr("stroke", "#d500f9").attr("stroke-width", 2).attr("d", extLineGen);

    // 6. 交互 (Tooltip)
    const focus = chartSvg.append("g").style("display", "none");
    focus.append("line").attr("y1", 0).attr("y2", innerHeight).attr("stroke", "white").attr("stroke-dasharray", "3,3").attr("opacity", 0.5);
    focus.append("circle").attr("r", 4).attr("fill", "white");

    chartSvg.append("rect").attr("width", innerWidth).attr("height", innerHeight).style("fill", "none").style("pointer-events", "all")
        .on("mouseover", () => { focus.style("display", null); tooltip.style("opacity", .9); })
        .on("mouseout", () => { focus.style("display", "none"); tooltip.style("opacity", 0); })
        .on("mousemove", function(event) {
            const x0 = x.invert(d3.pointer(event)[0]);
            const i = d3.bisector(d => d.hour).left(intensityData, x0, 1);
            const d = intensityData[i - 1];
            if (!d) return;

            focus.attr("transform", `translate(${x(d.hour)},${y(d.val)})`);
            
            const category = getCategory(mode === 'kt' ? d.val : cycloneTrack[i-1][2], d.isT, d.isE, d.isS);
            const unit = mode === 'kt' ? 'KT' : 'hPa';
            
            tooltip.html(`
                <div style="text-align: center;">
                    <strong class="text-slate-400">T+${d.hour}h</strong><br/>
                    <span style="color:white; font-size:1.1em">${d.val}${unit}</span><br/>
                    <span style="color:${category.color}; font-weight:bold; font-size:9px">${category.shortName}</span>
                </div>
            `)
            .style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
        });
}

export function drawAllHistoryTracks(mapSvg, mapProjection, historyList, world) {
    if (!historyList || historyList.length === 0) return;

    // 1. 清理动态层
    const layersToClear = [
        ".layer-pressure", ".layer-humidity", ".layer-forecast", 
        ".layer-wind-radii", ".layer-cyclone", ".track-interaction-layer", 
        ".layer-ui", ".layer-pressure-handles"
    ];
    layersToClear.forEach(selector => mapSvg.selectAll(selector).selectAll("*").remove());

    // 2. 准备数据并计算边界 (Bounds Calculation)
    const allSegments = [];
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    // 确定全局参考点，防止不同轨迹之间产生 360 度的跳跃
    const firstTrack = historyList.find(h => h.cycloneData?.track?.length > 0);
    if (!firstTrack) return;
    const referenceLon = firstTrack.cycloneData.track[0][0];

    historyList.forEach(item => {
        const rawTrack = item.cycloneData.track;
        if (!rawTrack || rawTrack.length < 2) return;

        // 这一步是关键：先进行局部展开，再进行全局对齐
        let lastUnwrappedLon = NaN;

        const unwrappedTrack = rawTrack.map((p, idx) => {
            let lon = p[0];
        
            // 1. 局部展开 (处理单条路径内的日界线)
            if (!isNaN(lastUnwrappedLon)) {
                let diff = lon - lastUnwrappedLon;
                if (Math.abs(diff) > 180) lon += (diff > 0) ? -360 : 360;
            }
        
            // 2. 全局对齐 (将整条路径平移到参考点附近，防止 NaN)
            // 只需要在处理每条路径的第一个点时计算平移量
            if (idx === 0) {
                while (lon - referenceLon > 180) lon -= 360;
                while (lon - referenceLon < -180) lon += 360;
            } else {
                // 后续点跟随第一个点的平移逻辑
                let shift = Math.round((lastUnwrappedLon - p[0]) / 360) * 360;
                lon += shift;
            }

            lastUnwrappedLon = lon;

            // 3. 统计边界
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, p[1]);
            maxLat = Math.max(maxLat, p[1]);

            return [lon, p[1], p[2], p[3], p[4], p[5], p[6]];
        });

        // 生成线段 (Feature 格式)
        for (let i = 0; i < unwrappedTrack.length - 1; i++) {
            const p1 = unwrappedTrack[i];
            const p2 = unwrappedTrack[i+1];
            allSegments.push({
                type: "Feature",
                properties: { 
                    color: getCategory(p2[2], p2[3], p2[4], p2[6]).color,
                    name: item.name,
                    intensity: p2[2]
                },
                geometry: { type: "LineString", coordinates: [p1.slice(0, 2), p2.slice(0, 2)] }
            });
        }
    });

    // 3. 动态调整投影 (Auto-Fit)
    const { width, height } = mapSvg.node().getBoundingClientRect();
    
    // 计算中心点
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    
    // 旋转地图以中心点为准
    mapProjection.rotate([-centerLon, 0]).center([0, centerLat]);

    // 计算缩放比例
    // 我们需要将 [minLon, maxLat] 到 [maxLon, minLat] 的范围放入屏幕
    // 添加 20% 的 Padding 避免贴边
    const lonSpan = Math.abs(maxLon - minLon) || 30; // 防止单一路径导致 span 为 0
    const latSpan = Math.abs(maxLat - minLat) || 20;
    
    // 简单的缩放估算 (Equirectangular 投影下)
    // 360度经度对应整个地球宽度
    // 这里的 scale 因子可能需要根据你的 D3 版本微调，通常 height / PI 是基准
    // 我们用 fitExtent 模拟：
    // 构造一个包围盒 GeoJSON
    const boundingBox = {
        type: "LineString",
        coordinates: [[minLon, minLat], [maxLon, maxLat]]
    };
    // 使用 fitExtent 自动计算最佳 scale 和 translate
    mapProjection.fitExtent([[50, 50], [width - 50, height - 50]], boundingBox);


    // 4. 绘制底图 (此时 Projection 已经设置好)
    // 传入空的 cyclone 对象以避免绘制当前气旋
    drawMap(mapSvg, mapProjection, world, {status: 'history_all', track: []}, {
    pathForecasts: [],
    pressureSystems: [],
    showPressureField: false,
    showHumidityField: false,
    showPathForecast: false,
    showWindRadii: false,
    siteName: null,
    siteLon: null,
    siteLat: null,
    });

    const trackLineLayer = mapSvg.select(".layer-track-lines");
    trackLineLayer.selectAll("*").remove(); 
    
    const pathGenerator = d3.geoPath().projection(mapProjection);

    // 5. 绘制所有历史线段
    trackLineLayer.selectAll(".history-segment")
        .data(allSegments)
        .enter().append("path")
        .attr("class", "history-segment")
        .attr("d", pathGenerator)
        .style("fill", "none")
        .style("stroke", d => d.properties.color)
        .style("stroke-width", 1.8)
        .style("stroke-opacity", 0.6)
        .style("stroke-linecap", "round")
        // [修复核心]: 使用 (event, d) 签名
        .on("mouseover", function(event, d) {
            d3.select(this)
                .style("stroke-opacity", 1.0)
                .style("stroke-width", 4)
                .style("stroke", "#ffffff") // 高亮为白色
                .raise(); // 提到最上层，防止被其他线遮挡
            
            const tooltip = d3.select(".tooltip");
            tooltip.transition().duration(50).style("opacity", .9);
            tooltip.html(
                `<div style="text-align:center">
                    <strong>${d.properties.name}</strong><br/>
                    <span style="color:${d.properties.color}">${Math.round(d.properties.intensity)} KT</span>
                </div>`
            )
            .style("left", (event.pageX + 10) + "px")
            .style("top", (event.pageY - 20) + "px");
        })
        // [修复核心]: 这里必须是 (event, d)，否则 d 是 Event 对象，读取不到 properties
        .on("mouseout", function(event, d) { 
            d3.select(this)
                .style("stroke-opacity", 0.6)
                .style("stroke-width", 1.8)
                .style("stroke", d.properties.color); // 恢复原始颜色
            
            d3.select(".tooltip").style("opacity", 0);
        });
}

function drawInteractivePressureSystems(container, mapProjection, renderableSystems, allPressureSystems, cyclone, onRemove) {
    
    const masterList = Array.isArray(allPressureSystems) ? allPressureSystems : (allPressureSystems.upper || []);
    const lowerList = Array.isArray(allPressureSystems) ? null : (allPressureSystems.lower || []);
    // 1. 获取当前视口的“视觉中心经度” (处理日界线)
    let viewCenterLon = mapProjection.center()[0];
    const rotation = mapProjection.rotate();
    if (Math.abs(rotation[0]) > 0.1) {
        viewCenterLon = -rotation[0];
    }

    // 2. 智能经度标准化函数
    const getVisualLon = (dataLon) => {
        let diff = dataLon - viewCenterLon;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;
        return viewCenterLon + diff;
    };

    // 绑定数据
    const handles = container.selectAll(".pressure-handle")
        .data(renderableSystems);

    // Enter
    const enterHandles = handles.enter().append("g")
        .attr("class", "pressure-handle")
        .style("cursor", "grab");

    // 绘制光晕
    enterHandles.append("circle")
        .attr("class", "halo")
        .attr("r", 20)
        .attr("fill", "none")
        .attr("stroke", d => d.strength > 0 ? "#2980b9" : "#c0392b")
        .attr("stroke-width", 1)
        .attr("opacity", 0.3)
        .style("pointer-events", "none");

    // 绘制核心圆
    enterHandles.append("circle")
        .attr("class", "core")
        .attr("r", 12)
        .attr("stroke", "white")
        .attr("stroke-width", 1.5)
        .attr("fill-opacity", 0.8);

    // 绘制文字
    enterHandles.append("text")
        .attr("dy", "0.35em")
        .attr("text-anchor", "middle")
        .style("font-family", "Arial, sans-serif")
        .style("font-weight", "bold")
        .style("font-size", "11px")
        .style("fill", "white")
        .style("pointer-events", "none");

    // Merge
    const allHandles = enterHandles.merge(handles);

    // [新增] 双击 H 标记删除该系统 (如果是手动生成的)
    allHandles.on("dblclick", (event, d) => {
        event.stopPropagation(); // 阻止事件冒泡到地图
        event.preventDefault();
        
        if (d.isManual && onRemove) {
            // 调用 main.js 传进来的回调函数进行删除
            onRemove(d); 
        }
    });

    // Update 位置 (初始化渲染)
    allHandles
        .attr("transform", d => {
            const visualLon = getVisualLon(d.x);
            const coords = mapProjection([visualLon, d.y]);
            if (!coords || isNaN(coords[0]) || isNaN(coords[1])) {
                return "translate(-9999, -9999)";
            }
            return `translate(${coords[0]}, ${coords[1]})`;
        });

    // Update 样式
    allHandles.select(".core").attr("fill", d => d.strength > 0 ? "#2980b9" : "#c0392b");
    allHandles.select(".halo").attr("stroke", d => d.strength > 0 ? "#2980b9" : "#c0392b");
    allHandles.select("text").text(d => d.strength > 0 ? "H" : "L");

    // Drag Behavior
const dragBehavior = d3.drag()
        .subject(function(event, d) {
            const visualLon = getVisualLon(d.x);
            const [px, py] = mapProjection([visualLon, d.y]);
            return { x: px, y: py };
        })
        .on("start", function(event, d) {
            d3.select(this).style("cursor", "grabbing");
            d3.select(this).select(".core").attr("stroke", "#f1c40f").attr("stroke-width", 3);
        })
        .on("drag", function(event, d) {
            // 1. 视觉跟随
            d3.select(this).attr("transform", `translate(${event.x}, ${event.y})`);

            // 2. 数据更新
            const coords = mapProjection.invert([event.x, event.y]);
            if (coords) {
                // 计算位移量 (用于同步 Lower 层)
                const dx = coords[0] - d.x;
                const dy = coords[1] - d.y;

                // A. 更新当前层 (Upper)
                d.x = coords[0];
                d.y = coords[1];

                // B. 同步更新 Lower 层
                // 假设 upper 和 lower 数组索引是一一对应的 (初始化时是一起 push 的)
                // 我们通过对象引用找不到 lower，必须通过 index 或 id 找
                if (lowerList) {
                    // 尝试通过数组索引匹配 (最高效，前提是数组没乱)
                    const index = masterList.indexOf(d);
                    if (index !== -1 && lowerList[index]) {
                        // 简单的同步：直接赋值
                        // 或者：应用相同的增量 (保留原有的微小相位差)
                        lowerList[index].x += dx;
                        lowerList[index].y += dy;
                    }
                }
            }
        })
        .on("end", function(event, d) {
            d3.select(this).style("cursor", "grab");
            d3.select(this).select(".core").attr("stroke", "white").attr("stroke-width", 1.5);
            
            // 强制刷新
            const svg = d3.select(this.closest("svg"));
            
            // 1. 重绘气压场 (传入完整的 obj)
            const pressureLayer = svg.select(".layer-pressure");
            if (!pressureLayer.empty()) {
                pressureLayer.selectAll("*").remove();
                drawPressureField(pressureLayer, mapProjection, allPressureSystems);
            }

            // 2. 重绘预测路径
            if (cyclone && cyclone.status === 'active') {
                const forecastLayer = svg.select(".layer-forecast");
                if (!forecastLayer.empty()) {
                    forecastLayer.selectAll("*").remove();
                    
                    const newForecasts = generatePathForecasts(cyclone, allPressureSystems, checkLandFast);
                    drawForecastCone(forecastLayer, mapProjection, newForecasts);
                    
                    const colors = d3.scaleOrdinal(d3.schemeCategory10);
                    const pathGenerator = d3.geoPath().projection(mapProjection);
                    
                    newForecasts.forEach((forecast, i) => {
                        const forecastGeoJSON = { type: "LineString", coordinates: forecast.track };
                        forecastLayer.append("path")
                            .datum(forecastGeoJSON)
                            .attr("class", "forecast-track")
                            .style("stroke", colors(i))
                            .attr("d", pathGenerator);
                    });
                }
            }
        });

    allHandles.call(dragBehavior);
    handles.exit().remove();
}

/**
 * 生成 JTWC 风格的静态分析图 (Canvas 版本)
 * [最终修正版 v6]
 * 1. 彻底修复末端封口内凹问题 (使用向量法强制外凸)
 * 2. 保持 dd/hhZ 格式和关键时间点筛选
 */
export function renderJTWCStyle(cyclone, timeIndex, worldData) {
    // 1. 设置高分辨率画布
    const width = 1600;
    const height = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const unwrapLon = (lon, refLon) => {
        let diff = lon - refLon;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return refLon + diff;
    };

    // 2. 数据准备与预处理
    const currentPointRaw = cyclone.track[timeIndex];
    const centerLon = currentPointRaw[0]; // 以此为视觉中心
    const centerLat = currentPointRaw[1];

    // A. 处理历史路径 (解包)
    const pastTrack = cyclone.track.slice(0, timeIndex + 1).map(p => {
        const newP = [...p];
        newP[0] = unwrapLon(p[0], centerLon);
        return newP;
    });
    const currentPoint = pastTrack[timeIndex]; // 更新为解包后的当前点

    // B. 获取预测数据并解包
    const currentAge = timeIndex * 3; 
    const snapAge = Math.floor(currentAge / 6) * 6; 
    
    let forecastModelsRaw = [];
    if (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) {
        forecastModelsRaw = cyclone.forecastLogs[snapAge];
    } else if (cyclone.status === 'active' && cyclone.pathForecasts) {
        forecastModelsRaw = cyclone.pathForecasts;
    }

    // 对预测模型数据进行解包处理 (Deep Copy & Unwrap)
    const forecastModels = forecastModelsRaw.map(model => {
        return {
            ...model,
            track: model.track.map(p => {
                const newP = [...p];
                newP[0] = unwrapLon(p[0], centerLon);
                return newP;
            })
        };
    });

    // 3. 投影设置 [关键修复]
    // 使用 rotate 将中心经度旋转到 0 度位置，从而将日界线切割口移到地球背面
    const projection = d3.geoEquirectangular()
        .rotate([-centerLon, 0]) // 旋转地球，使 centerLon 位于平面中心
        .center([0, centerLat])  // 此时中心经度已变为0 (相对值)
        .scale(3500) 
        .translate([width / 2, height / 2]);

    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    // --- 绘图开始 ---

    // A. 背景
    ctx.fillStyle = "#b8c8d8"; 
    ctx.fillRect(0, 0, width, height);

    // B. 经纬网
    ctx.beginPath();
    ctx.strokeStyle = "#444444";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    const graticule = d3.geoGraticule().step([2, 2]);
    pathGenerator(graticule());
    ctx.stroke();
    ctx.setLineDash([]); 

    // C. 陆地
    ctx.beginPath();
    ctx.fillStyle = "#e8d888"; 
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 1;
    pathGenerator(worldData);
    ctx.fill();
    ctx.stroke();

    const majorCities = [
        // 西太/东亚
        { name: "SAIPAN", lon: 145.7, lat: 15.2 },
        { name: "MANILA", lon: 120.98, lat: 14.6 },
        { name: "TAIPEI", lon: 121.5, lat: 25.05 },
        { name: "HONG KONG", lon: 114.17, lat: 22.3 },
        { name: "SHANGHAI", lon: 121.47, lat: 31.23 },
        { name: "SEOUL", lon: 126.98, lat: 37.56 },
        { name: "TOKYO", lon: 139.69, lat: 35.69 },
        { name: "HO CHI MINH", lon: 106.63, lat: 10.82 },
        { name: "NAHA", lon: 127.68, lat: 26.21 }, // 冲绳
        { name: "GUAM", lon: 144.7, lat: 13.4 },   // 关岛
        { name: "IWO TO", lon: 141.3, lat: 24.8 }, // 硫磺岛

        // 北美/中太
        { name: "HONOLULU", lon: -157.86, lat: 21.31 },
        { name: "LOS ANGELES", lon: -118.24, lat: 34.05 },
        { name: "NEW YORK", lon: -74.00, lat: 40.71 },
        { name: "HOUSTON", lon: -95.37, lat: 29.76 },
        { name: "SAN FRANCISCO", lon: -122.42, lat: 37.77 },

        // 南半球
        { name: "BRISBANE", lon: 153.02, lat: -27.47 },
        { name: "DARWIN", lon: 130.84, lat: -12.46 },
        { name: "CAIRNS", lon: 145.77, lat: -16.92 }
    ];

    ctx.save();
    ctx.fillStyle = "black";
    ctx.font = "bold 9px Arial"; // JTWC 风格通常字号较小且清晰
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    majorCities.forEach(city => {
        // 投影坐标
        const pos = projection([city.lon, city.lat]);
        
        // 边界检查：只绘制在画布范围内的城市
        // 留出一点边距 (padding) 防止文字贴边
        if (pos && pos[0] > 10 && pos[0] < width - 10 && pos[1] > 10 && pos[1] < height - 10) {
            
            // 1. 绘制黑色小方块 (Marker)
            ctx.fillRect(pos[0] - 2, pos[1] - 2, 4, 4);
            
            // 2. 绘制文字 (Label)
            // 默认显示在右侧，如果靠右边界太近则显示在左侧
            if (pos[0] > width - 80) {
                ctx.textAlign = "right";
                ctx.fillText(city.name, pos[0] - 5, pos[1]);
            } else {
                ctx.textAlign = "left";
                ctx.fillText(city.name, pos[0] + 5, pos[1]);
            }
        }
    });
    ctx.restore();

    // D. 预测锥 (Forecast Cone)
    if (forecastModels.length > 0 && forecastModels[0].track.length > 1) {
        const maxSteps = d3.max(forecastModels, m => m.track.length);
        
        // [步骤 0] 预计算完美截断点 (与实时图逻辑一致)
        let rawDeathIndex = maxSteps;
        // 计算平均强度的消散点
        for (let i = 0; i < maxSteps; i++) {
            const points = [];
            forecastModels.forEach(m => { if(m.track[i]) points.push(m.track[i]); });
            if (points.length > 0) {
                const avgInt = d3.mean(points, p => p[2]);
                if (avgInt <= 15) {
                    rawDeathIndex = i;
                    break;
                }
            }
        }

        const keyframes = [4, 8, 12, 16, 24];
        let quantizedLimit = 8; // Min 24h
        for (let k of keyframes) {
            if (rawDeathIndex >= k) {
                quantizedLimit = k;
            } else {
                break;
            }
        }
        quantizedLimit = Math.min(quantizedLimit, maxSteps - 1);

        // 开始绘制
        let lastStepData = null;
        const boundaryPoints = []; 
        const rawSteps = [];
        const meanTrack = []; // 用于收集中心线

        for (let i = 0; i <= quantizedLimit; i++) {
            const pointsAtStep = [];
            forecastModels.forEach(m => {
                if (m.track[i]) pointsAtStep.push(m.track[i]);
            });

            if (pointsAtStep.length === 0) continue;

            const avgLon = d3.mean(pointsAtStep, p => p[0]);
            const avgLat = d3.mean(pointsAtStep, p => p[1]);
            
            // 收集中心线
            meanTrack.push([avgLon, avgLat]);

            const stdDev = d3.deviation(pointsAtStep, p => {
                const dx = (p[0] - avgLon) * Math.cos(avgLat * Math.PI / 180);
                const dy = p[1] - avgLat;
                return Math.sqrt(dx*dx + dy*dy);
            }) || 0;

            const jitter = Math.sin(i * 132.19 + snapAge) * 0.1; 
            const breathing = Math.cos(i * 0.5) * 0.03;
            let radiusDeg = Math.max(0.02, (0.02 + i * 0.14) + (stdDev * 1.5) + (jitter + breathing) * (1 + i * 0.05));
rawSteps.push({
                lon: avgLon,
                lat: avgLat,
                r: radiusDeg,
                cosL: Math.cos(avgLat * Math.PI / 180) // 缓存纬度校正系数
            });
        }
        
        for (let i = 0; i < rawSteps.length; i++) {
            const curr = rawSteps[i];
            const prev = rawSteps[i - 1];
            const next = rawSteps[i + 1];

            // 计算切线向量 (dx, dy)
            let dx = 0, dy = 0;

            if (i === 0 && next) {
                // 起点：指向下一个点
                dx = (next.lon - curr.lon) * curr.cosL;
                dy = next.lat - curr.lat;
            } else if (i === rawSteps.length - 1 && prev) {
                // 终点：延续上一个点的方向
                dx = (curr.lon - prev.lon) * curr.cosL;
                dy = curr.lat - prev.lat;
            } else if (prev && next) {
                // [关键修复] 中间点：使用前后两段向量的平均值 (角平分线逻辑)
                // 向量1: Prev -> Curr
                const v1x = (curr.lon - prev.lon) * curr.cosL;
                const v1y = curr.lat - prev.lat;
                // 向量2: Curr -> Next
                const v2x = (next.lon - curr.lon) * curr.cosL;
                const v2y = next.lat - curr.lat;
                
                // 简单的向量相加即可得到平滑切线
                dx = v1x + v2x;
                dy = v1y + v2y;
            }

            // 如果重合或异常，给默认方向
            if (dx === 0 && dy === 0) { dx = 1; dy = 0; }

            // 计算法线角度 (切线 + 90度)
            const angle = Math.atan2(dy, dx);
            const normal = angle + Math.PI / 2;

            // 计算左右边界坐标 (Lat/Lon)
            // 注意：经度偏移需要除以 cosL
            const leftLon = curr.lon + (curr.r * Math.cos(normal) / curr.cosL);
            const leftLat = curr.lat + (curr.r * Math.sin(normal));
            
            const rightLon = curr.lon + (curr.r * Math.cos(normal + Math.PI) / curr.cosL);
            const rightLat = curr.lat + (curr.r * Math.sin(normal + Math.PI));

            // 投影到屏幕坐标
            const pCenter = projection([curr.lon, curr.lat]);
            const pLeft = projection([leftLon, leftLat]);
            const pRight = projection([rightLon, rightLat]);

            if (pCenter && pLeft && pRight) {
                // 计算屏幕上的像素半径 (用于最后的圆头绘制)
                const screenR = Math.hypot(pLeft[0] - pCenter[0], pLeft[1] - pCenter[1]);
                boundaryPoints.push({ left: pLeft, right: pRight, center: pCenter, radius: screenR });
            }
        }

        // --- 2. 定义通用路径函数 ---
        // 这个函数会在主画布(Stroke)和离屏画布(Fill)上重复使用，确保形状完全一致
        const drawConePath = (context) => {
            if (boundaryPoints.length < 2) return;
            context.beginPath();
            context.moveTo(boundaryPoints[0].left[0], boundaryPoints[0].left[1]);
            for (let i = 1; i < boundaryPoints.length; i++) {
                context.lineTo(boundaryPoints[i].left[0], boundaryPoints[i].left[1]);
            }
            const lastBP = boundaryPoints[boundaryPoints.length - 1];
            const startAngle = Math.atan2(lastBP.left[1] - lastBP.center[1], lastBP.left[0] - lastBP.center[0]);
            const endAngle = Math.atan2(lastBP.right[1] - lastBP.center[1], lastBP.right[0] - lastBP.center[0]);
            context.arc(lastBP.center[0], lastBP.center[1], lastBP.radius, startAngle, endAngle, false);
            for (let i = boundaryPoints.length - 2; i >= 0; i--) {
                context.lineTo(boundaryPoints[i].right[0], boundaryPoints[i].right[1]);
            }
            context.closePath();
        };

        const shapeCanvas = document.createElement('canvas');
        shapeCanvas.width = width; shapeCanvas.height = height;
        const shapeCtx = shapeCanvas.getContext('2d');
        drawConePath(shapeCtx);
        shapeCtx.fillStyle = "#000000"; shapeCtx.fill();

        const patternCanvas = document.createElement('canvas');
        patternCanvas.width = 16; patternCanvas.height = 16;
        const pCtx = patternCanvas.getContext('2d');
        pCtx.strokeStyle = "rgba(50, 200, 255, 0.4)"; 
        pCtx.lineWidth = 2; pCtx.beginPath(); pCtx.moveTo(0, 16); pCtx.lineTo(16, 0); pCtx.stroke();
        const hatchPattern = ctx.createPattern(patternCanvas, 'repeat');

        shapeCtx.globalCompositeOperation = "source-in";
        shapeCtx.fillStyle = hatchPattern; shapeCtx.fillRect(0, 0, width, height);
        
        ctx.drawImage(shapeCanvas, 0, 0);

        ctx.save();
        drawConePath(ctx); 
        ctx.strokeStyle = "#ff0000"; ctx.lineWidth = 2; ctx.setLineDash([12, 6]); ctx.stroke();
        ctx.restore();

        // --- 4. 绘制中心线 ---
        if (meanTrack.length > 0) {
            ctx.beginPath();
            ctx.strokeStyle = "#282888"; ctx.lineWidth = 2;
            const lineFeature = { type: "LineString", coordinates: meanTrack };
            pathGenerator(lineFeature);
            ctx.stroke(); ctx.setLineDash([]);
        }
        
        // --- 5. 预测点标签 (修改版) ---
        const targetHours = [12, 24, 36, 48, 72]; 
        let lastLabelPos = null; // 用于记录上一个标签的位置

        targetHours.forEach(h => {
            const idx = h / 3; 
            if (idx > quantizedLimit) return;

            // 1. 获取集合平均位置 (当前点)
            const points = [];
            forecastModels.forEach(m => { if(m.track[idx]) points.push(m.track[idx]); });
            if (points.length === 0) return;
            
            const p = [d3.mean(points, v=>v[0]), d3.mean(points, v=>v[1])];
            const pos = projection(p); // 屏幕坐标 [x, y]
            if (!pos) return;

            const avgIntensity = d3.mean(points, v => v[2]);
            const roundedIntensity = Math.round(avgIntensity / 5) * 5;

            // 2. 获取前后点以计算切线方向
            let nextP = null;
            let prevP = null;

            // 找 next
            const nextPoints = [];
            if (idx + 1 < maxSteps) {
                forecastModels.forEach(m => { if(m.track[idx+1]) nextPoints.push(m.track[idx+1]); });
                if (nextPoints.length > 0) {
                    const np = [d3.mean(nextPoints, v=>v[0]), d3.mean(nextPoints, v=>v[1])];
                    nextP = projection(np);
                }
            }
            // 找 prev
            const prevPoints = [];
            if (idx - 1 >= 0) {
                forecastModels.forEach(m => { if(m.track[idx-1]) prevPoints.push(m.track[idx-1]); });
                if (prevPoints.length > 0) {
                    const pp = [d3.mean(prevPoints, v=>v[0]), d3.mean(prevPoints, v=>v[1])];
                    prevP = projection(pp);
                }
            }

            // 3. 计算路径切线角度
            let tangentAngle = 0;
            if (nextP && prevP) {
                tangentAngle = Math.atan2(nextP[1] - prevP[1], nextP[0] - prevP[0]);
            } else if (nextP) {
                tangentAngle = Math.atan2(nextP[1] - pos[1], nextP[0] - pos[0]);
            } else if (prevP) {
                tangentAngle = Math.atan2(pos[1] - prevP[1], pos[0] - prevP[0]);
            }

            // ==========================================
            // [核心修改] 4. 计算引线方向 & 碰撞检测
            // ==========================================
            const offsetDist = 145; // 引线长度
            let normalAngle = tangentAngle + Math.PI / 2; // 默认向右
            
            // 先计算一次预定位置
            let labelX = pos[0] + Math.cos(normalAngle) * offsetDist;
            let labelY = pos[1] + Math.sin(normalAngle) * offsetDist;

            // 检查与上一个标签的垂直距离 (防重叠)
            if (lastLabelPos) {
                const dy = Math.abs(labelY - lastLabelPos.y);
                // 如果垂直距离小于 30px (字体是20px，留点空隙)，说明挤了
                if (dy < 30) {
                    // 翻转 180 度 (变为向左/另一侧)
                    normalAngle += Math.PI;
                    
                    // 重新计算坐标
                    labelX = pos[0] + Math.cos(normalAngle) * offsetDist;
                    labelY = pos[1] + Math.sin(normalAngle) * offsetDist;
                }
            }

            // 更新上一个标签位置记录
            lastLabelPos = { x: labelX, y: labelY };
            // ==========================================

            // 5. 绘制实心点
            ctx.beginPath();
            ctx.fillStyle = "#282888";
            ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2);
            ctx.fill();

            // 6. 绘制引线
            ctx.beginPath();
            ctx.strokeStyle = "black";
            ctx.lineWidth = 1;
            ctx.moveTo(pos[0], pos[1]);
            ctx.lineTo(labelX, labelY);
            ctx.stroke();

            // 7. 绘制文字 (智能对齐)
            ctx.fillStyle = "black";
            ctx.font = "bold 20px 'JetBrains Mono', monospace";
            ctx.textBaseline = "middle";

            // [新增] 现场计算并规整时间 (Round to nearest 6H)
            // 1. 重建时间基准 (假设模拟从当月1号 00:00Z 开始)
            const year = new Date().getFullYear();
            const month = (cyclone.currentMonth || 8) - 1; 
            const calcDate = new Date(Date.UTC(year, month, 1));
            
            // 2. 加上 (当前模拟时间 + 预测偏移小时数)
            calcDate.setUTCHours(calcDate.getUTCHours() + currentAge + h);
            
            // 3. 执行 6小时 四舍五入 (Round)
            let resultH = calcDate.getUTCHours();
            const rem = resultH % 6;
            if (rem > 3) {
                resultH += (6 - rem); // >=3小时则进位
            } else {
                resultH -= rem;       // <3小时则舍去
            }
            calcDate.setUTCHours(resultH, 0, 0, 0); // 应用规整后的时间

            // 4. 格式化字符串 (DD/HHZ)
            const dateStr = `${String(calcDate.getUTCDate()).padStart(2,'0')}/${String(calcDate.getUTCHours()).padStart(2,'0')}Z`;

            // 根据 labelX 相对于 pos[0] 的位置决定文字对齐方向
            if (labelX > pos[0]) {
                ctx.textAlign = "left";
                ctx.fillText(`  ${dateStr}, ${roundedIntensity}KT`, labelX, labelY);
            } else {
                ctx.textAlign = "right";
                ctx.fillText(`${dateStr}, ${roundedIntensity}KT  `, labelX, labelY);
            }
        });
    }

    // --- 辅助函数：日期格式化 ---
    function calculateDateStr(currentAge, forecastHour, cyclone) {
        const year = new Date().getFullYear();
        const month = (cyclone.currentMonth || 7) - 1; 
        const startDay = 1;
        
        const totalSimHours = currentAge + forecastHour;
        const dateObj = new Date(Date.UTC(year, month, startDay));
        dateObj.setUTCHours(dateObj.getUTCHours() + totalSimHours);
        
        const dd = String(dateObj.getUTCDate()).padStart(2, '0');
        const hh = String(dateObj.getUTCHours()).padStart(2, '0');
        return `${dd}/${hh}Z`; 
    }

    // E. 历史路径
    if (pastTrack.length > 0) {
        ctx.beginPath();
        ctx.strokeStyle = "black";
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.setLineDash([4, 2]);
        const trackFeature = {
            type: "LineString",
            coordinates: pastTrack.map(p => [p[0], p[1]])
        };
        pathGenerator(trackFeature);
        ctx.stroke();
    }

    // F. 历史点 (Optimized Icons)
    // 预设置字体：必须匹配 CSS 中引入的版本 (Font Awesome 6 Free Solid)
    ctx.font = '900 16px "Font Awesome 6 Free"';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const hurricaneIcon = '\uf751'; // fa-hurricane 的 Unicode 编码

    pastTrack.forEach((p, i) => {
        // 保持每 6 小时一个点的稀疏度 (假设每步3小时)
        if (i % 2 !== 0) return;
        
        const pos = projection(p);
        if (!pos) return;

        const intensity = p[2]; // 获取强度

        if (intensity >= 64) {
            // [>= 64 KT] 实心台风图标 (TY)
            // 1. 先画一个白色背景圆，遮挡住底下的路径线，防止线条穿过图标
            ctx.beginPath();
            ctx.fillStyle = "white"; 
            ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2);
            ctx.fill();

            // 2. 绘制实心图标
            ctx.fillStyle = "black";
            ctx.fillText(hurricaneIcon, pos[0], pos[1]);

        } else if (intensity >= 34) {
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.fillStyle = "white";
            ctx.strokeStyle = "black";
            ctx.lineWidth = 1.5;
            ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

        } else {
            // [< 34 KT] 原样：空心圆点 (TD)
            ctx.beginPath();
            ctx.strokeStyle = "black";
            ctx.lineWidth = 1.5;
            ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    });

    // G. 当前位置 & 风圈
    const intensity = currentPoint[2]; 
    const savedR34 = currentPoint[7];
    const savedR50 = currentPoint[8];
    const savedR64 = currentPoint[9];
    const sizeParam = currentPoint[5] || cyclone.circulationSize || 200;

    const windRadiiConfig = [
        { kt: 34, color: '#ff0000', width: 1.5 },
        { kt: 50, color: '#ffa500', width: 2.0 },
        { kt: 64, color: '#800080', width: 2.5 }
    ];

    // 读取数据
    const radiiData = {
        34: savedR34,
        50: savedR50,
        64: savedR64
    };

    // 辅助函数：绘制非对称风圈路径
    const drawAsymmetricCircle = (ctx, center, radii, color, width) => {
        if (radii.every(r => r <= 0)) return;
        
        const c = projection(center); // 中心点屏幕坐标 [x, y]
        if (!c) return;
        const cx = c[0];
        const cy = c[1];

        ctx.beginPath();

        // 辅助函数：计算该纬度下的像素半径 (X轴和Y轴分开计算)
        // degRadius: 物理半径(度)
        const getEllipseRadii = (degRadius) => {
            if (degRadius <= 0) return { rx: 0, ry: 0 };
            
            // Y轴 (纬度) 像素半径：直接计算向北的投影距离
            const pNorth = projection([center[0], center[1] + degRadius]);
            const ry = Math.abs(pNorth[1] - cy);

            // X轴 (经度) 像素半径：计算向东的投影距离
            // 注意：在高纬度，同样经度差的物理距离变短，投影会将其拉伸以保持矩形网格
            const pEast = projection([center[0] + degRadius, center[1]]);
            const rx = Math.abs(pEast[0] - cx);

            return { rx, ry };
        };

        // 四个象限的半径数据 (NE, SE, SW, NW)
        const rads = [
            getEllipseRadii(radii[0]), // NE
            getEllipseRadii(radii[1]), // SE
            getEllipseRadii(radii[2]), // SW
            getEllipseRadii(radii[3])  // NW
        ];

        // 绘制四段椭圆弧
        // Canvas ellipse 参数: (x, y, radiusX, radiusY, rotation, startAngle, endAngle)
        
        // 1. NE Quadrant (上 -> 右)
        // 使用 NE 的 rx 和 ry
        if (rads[0].rx > 0) {
            ctx.ellipse(cx, cy, rads[0].rx, rads[0].ry, 0, -Math.PI/2, 0);
        } else {
            ctx.moveTo(cx, cy);
        }

        // 2. SE Quadrant (右 -> 下)
        if (rads[1].rx > 0) {
            // 需要连线到起点吗？ellipse 会自动连线，但为了保险
            ctx.ellipse(cx, cy, rads[1].rx, rads[1].ry, 0, 0, Math.PI/2);
        } else {
            ctx.lineTo(cx, cy);
        }

        // 3. SW Quadrant (下 -> 左)
        if (rads[2].rx > 0) {
            ctx.ellipse(cx, cy, rads[2].rx, rads[2].ry, 0, Math.PI/2, Math.PI);
        } else {
            ctx.lineTo(cx, cy);
        }

        // 4. NW Quadrant (左 -> 上)
        if (rads[3].rx > 0) {
            ctx.ellipse(cx, cy, rads[3].rx, rads[3].ry, 0, Math.PI, -Math.PI/2);
        } else {
            ctx.lineTo(cx, cy);
        }

        ctx.closePath(); // 闭合路径

        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash([]); 
        ctx.stroke();
    };
    // 绘制风圈
    windRadiiConfig.forEach(cfg => {
        if (intensity >= cfg.kt) {
            let radii = [0, 0, 0, 0];
            if (Array.isArray(radiiData[cfg.kt])) {
                radii = radiiData[cfg.kt];
            } else if (typeof radiiData[cfg.kt] === 'number') {
                const r = radiiData[cfg.kt];
                radii = [r, r, r, r];
            } else {
                const r = (sizeParam / 80) * Math.pow(intensity / cfg.kt, 0.6);
                radii = [r, r, r, r];
            }
            drawAsymmetricCircle(ctx, [currentPoint[0], currentPoint[1]], radii, cfg.color, cfg.width);
        }
    });

    // G. 当前位置
    const currPos = projection(currentPoint);
    if (currPos) {
        ctx.beginPath();
        ctx.fillStyle = "#ff0000"; 
        ctx.strokeStyle = "black";
        ctx.lineWidth = 2;
        ctx.arc(currPos[0], currPos[1], 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        ctx.fillStyle = "black";
        ctx.font = "bold 20px Arial"; // 保持原字体，或者换成 'JetBrains Mono' 也可以
        ctx.textAlign = "left";
        
        const name = (cyclone.name || "NONAME").toUpperCase();
        
        // [新增] 获取强度并取整到最近的 5KT
        // currentPoint 结构通常是 [lon, lat, intensity, ...]
        const rawIntensity = currentPoint[2]; 
        const roundedIntensity = Math.round(rawIntensity / 5) * 5;
        
        // 显示名字 + 强度
        ctx.fillText(`${name}, ${roundedIntensity}KT`, currPos[0] + 20, currPos[1] + 10);
    }

    // H. 装饰
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, 50);
    ctx.fillStyle = "white";
    ctx.font = "bold 20px Arial";
    ctx.textAlign = "left";
    const reportNum = timeIndex + 1;
    ctx.fillText(`PROGNOSTIC REASONING: ${(cyclone.name || 'TD').toUpperCase()} #${reportNum}`, 20, 32);
    ctx.textAlign = "right";
    ctx.fillText("INDEPENDENT CYCLONE WARNING CENTER", width - 20, 32);

    ctx.fillStyle = "red";
    ctx.font = "bold 16px Arial";
    ctx.textAlign = "center";
    ctx.fillText("WARNING: THIS IS NOT REAL LOL / FOR SIMULATION ONLY", width / 2, height - 20);
    
    // I. 绘制图例 (Legend)
    // ============================================================
    const legendW = 260;
    const legendH = 210;
    const legendX = width - legendW - 20; // 右对齐，留出20px边距
    const legendY = 60; // 标题栏下方

    ctx.save();
    
    // 1. 图例背景框 (白底黑边)
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 1;
    ctx.fillRect(legendX, legendY, legendW, legendH);
    ctx.strokeRect(legendX, legendY, legendW, legendH);

    // 2. 图例内容配置
    const lineHeight = 25;
    const startX = legendX + 20;
    const startY = legendY + 25;
    const iconX = startX + 10; // 图标中心X
    
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "black";

    // --- Item 1: LESS THAN 34 KT (空心圆) ---
    let currentY = startY;
    ctx.setLineDash([4,2]);
    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 1.5;
    ctx.arc(iconX, currentY, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText("LESS THAN 34 KT", startX + 30, currentY);

    // --- Item 2: 34-63 KT (白底黑圈) ---
    currentY += lineHeight;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 1.5;
    ctx.arc(iconX, currentY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "black"; // 恢复文字颜色
    ctx.fillText("34-63 KT", startX + 30, currentY);

    // --- Item 3: MORE THAN 63 KT (台风图标) ---
    currentY += lineHeight;
    // 先画白底遮挡
    ctx.beginPath();
    ctx.fillStyle = "white";
    ctx.arc(iconX, currentY, 5, 0, Math.PI * 2);
    ctx.fill();
    // 画图标
    ctx.fillStyle = "black";
    ctx.font = '900 12px "Font Awesome 6 Free"'; // 确保字体一致
    ctx.textAlign = "center";
    const faHurricane = '\uf751';
    ctx.fillText(faHurricane, iconX, currentY);
    // 恢复文字设置
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "left";
    ctx.fillText("MORE THAN 63 KT", startX + 30, currentY);

    // --- Item 4: PAST CYCLONE TRACK (实线) ---
    currentY += lineHeight;
    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 3;
    ctx.moveTo(startX - 5, currentY);
    ctx.lineTo(startX + 25, currentY);
    ctx.stroke();
    ctx.fillStyle = "black";
    ctx.fillText("PAST CYCLONE TRACK", startX + 30, currentY);

    // --- Item 5: FORECAST CYCLONE TRACK (虚线) ---
    currentY += lineHeight;
    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.moveTo(startX - 5, currentY);
    ctx.lineTo(startX + 25, currentY);
    ctx.stroke();
    ctx.setLineDash([]); // 重置
    ctx.fillStyle = "black";
    ctx.fillText("FORECAST CYCLONE TRACK", startX + 30, currentY);

    // --- Item 6: UNCERTAINTY CONE AREA (红斜线) ---
    currentY += lineHeight;
    // 重新创建纹理 (因为 pattern 变量作用域问题)
    const legPatCv = document.createElement('canvas');
    legPatCv.width = 10; legPatCv.height = 10;
    const lpCtx = legPatCv.getContext('2d');
    lpCtx.strokeStyle = "rgba(60, 220, 255, 0.4)";
    lpCtx.lineWidth = 2;
    lpCtx.beginPath();
    lpCtx.moveTo(0, 10); lpCtx.lineTo(10, 0);
    lpCtx.stroke();
    const legPattern = ctx.createPattern(legPatCv, 'repeat');

    // 画矩形示例
    ctx.save();
    ctx.fillStyle = legPattern;
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 2]);
    const rectX = startX - 5;
    const rectY = currentY - 6;
    ctx.fillRect(rectX, rectY, 30, 12);
    ctx.strokeRect(rectX, rectY, 30, 12);
    ctx.restore();

    ctx.fillStyle = "black";
    ctx.fillText("UNCERTAINTY CONE AREA", startX + 30, currentY);

    ctx.restore();

    //Item 7: Wind Radii Legend ---
    currentY += lineHeight + 8; // 多留一点空隙给双行文字
    
    // 绘制同心圆图标
    ctx.save();
    ctx.setLineDash([]); 
    // 外圈 (34KT - Red)
    ctx.beginPath(); ctx.strokeStyle = "#ff0000"; ctx.lineWidth = 1.5;
    ctx.arc(iconX, currentY, 14, 0, Math.PI * 2); ctx.stroke();
    // 中圈 (50KT - Orange)
    ctx.beginPath(); ctx.strokeStyle = "#ffa500"; ctx.lineWidth = 1.5;
    ctx.arc(iconX, currentY, 9, 0, Math.PI * 2); ctx.stroke();
    // 内圈 (64KT - Purple)
    ctx.beginPath(); ctx.strokeStyle = "#800080"; ctx.lineWidth = 1.5;
    ctx.arc(iconX, currentY, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // 绘制双行文字
    ctx.fillStyle = "black";
    ctx.font = "bold 12px Arial"; // 稍微缩小字体以适应两行
    ctx.textAlign = "left";
    ctx.fillText("34/50/64 KNOT WIND RADII", startX + 30, currentY - 6);
    ctx.fillText("(VALID OVER OPEN OCEAN ONLY)", startX + 30, currentY + 6);

    ctx.restore();

    // ============================================================
    // J. 绘制水印 (Watermark)
    // ============================================================
    ctx.save();
    ctx.font = "900 32px 'Inter', sans-serif"; // 使用粗壮的现代字体
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)"; // 低透明度黑色
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    
    // 绘制在右下角 (留出一点边距)
    ctx.fillText("STORM_INC®", width - 20, height - 10);

    return canvas;
}

/**
 * 渲染风速概率图 (Wind Speed Probability)
 * [泛化版] 支持 34kt 和 64kt 阈值
 * @param {number} threshold - 风速阈值 (34 或 64)
 */
export function renderProbabilitiesStyle(cyclone, timeIndex, worldData, threshold = 34) {
    const width = 1600;
    const height = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // --- 安全检查 ---
    if (!cyclone || !cyclone.track) {
        drawErrorText(ctx, width, height, "NO CYCLONE DATA");
        return canvas;
    }

    // 1. 基础设置
    const safeIndex = (timeIndex >= 0 && timeIndex < cyclone.track.length) ? timeIndex : cyclone.track.length - 1;
    const currentPointRaw = cyclone.track[safeIndex];
    const centerLon = currentPointRaw[0]; 
    const centerLat = currentPointRaw[1];

    const projection = d3.geoEquirectangular()
        .rotate([-centerLon, 0]) 
        .center([0, centerLat])  
        .scale(3500) 
        .translate([width / 2, height / 2]);

    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    // 计算像素比例
    const pCenter = projection([0, 0]);
    const pRight = projection([1, 0]);
    const pxPerDeg = pRight[0] - pCenter[0]; 

    // 2. 绘制背景
    ctx.fillStyle = "#6fa3cf"; 
    ctx.fillRect(0, 0, width, height);

    // 3. 绘制经纬网
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    pathGenerator(d3.geoGraticule().step([5, 5])());
    ctx.stroke();
    ctx.setLineDash([]);

    // --- 4. 获取预测数据 & 锁定真实风圈 ---
    let forecasts = null;
    const currentAge = safeIndex * 3;
    const snapAge = Math.floor(currentAge / 6) * 6;

    if (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) {
        forecasts = cyclone.forecastLogs[snapAge];
    }
    if (!forecasts && cyclone.pathForecasts) {
        forecasts = cyclone.pathForecasts;
    }

    if (!forecasts || forecasts.length === 0 || !forecasts[0].track || forecasts[0].track.length === 0) {
        ctx.beginPath();
        ctx.fillStyle = "#ffffff"; 
        ctx.strokeStyle = "black"; 
        pathGenerator(worldData);
        ctx.fill(); ctx.stroke();
        drawErrorText(ctx, width, height, "NO FORECAST DATA");
        return canvas;
    }

    // [关键修正] 获取真实风圈数据
    // 34kt 对应 index 7, 64kt 对应 index 9 (假设 index 8 是 50kt)
    const radiusIndex = (threshold === 64) ? 9 : 7;
    let realRadiusPx = 0;
    const historyPoint = cyclone.track[safeIndex];
    
    if (historyPoint && historyPoint[radiusIndex] && Array.isArray(historyPoint[radiusIndex])) {
        const maxRDeg = Math.max(...historyPoint[radiusIndex]);
        if (maxRDeg > 0) {
            realRadiusPx = maxRDeg * pxPerDeg * 0.7; 
        }
    }

    // 保底估算逻辑
    if (realRadiusPx <= 0) {
        const intensity = historyPoint[2] || 0;
        if (intensity >= threshold) {
            // 简单的线性估算
            const estimatedDeg = 0.5 + (intensity - threshold) * 0.015; 
            realRadiusPx = estimatedDeg * pxPerDeg * 0.7;
        } else {
            // 如果强度没达到阈值，给一个极小的基础值用于概率计算
            realRadiusPx = 16 - 0.2 * threshold; 
        }
    }

    // --- 5. 生成概率场 ---
    const gridW = 200; 
    const gridH = 150; 
    const values = new Float32Array(gridW * gridH).fill(0);
    const track = forecasts[0].track;

    const scaleX = gridW / width;
    const scaleY = gridH / height;
    const pseudoRandom = (x, y) => Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;

    for (let k = 0; k < track.length - 1; k++) {
        const p1 = track[k];
        const p2 = track[k+1];
        
        const pos1 = projection([p1[0], p1[1]]);
        const pos2 = projection([p2[0], p2[1]]);
        
        if (!pos1 || !pos2) continue;

        const distPx = Math.hypot(pos2[0] - pos1[0], pos2[1] - pos1[1]);
        const steps = Math.max(1, Math.ceil(distPx / 15)); 

        for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const px = pos1[0] + (pos2[0] - pos1[0]) * t;
            const py = pos1[1] + (pos2[1] - pos1[1]) * t;
            
            if (px < 0 || px >= width || py < 0 || py >= height) continue;

            const hour = (k + t) * 3;
            const intensity = p1[2] + (p2[2] - p1[2]) * t;
            
            // 应用当前真实风圈 (随强度微调)
            let currentRadiusPx = realRadiusPx;
            const baseIntensity = historyPoint[2];
            
            if (baseIntensity > threshold) {
                // 如果当前已经是 64kt+，预测更强则变大，预测弱则变小
                const ratio = intensity / baseIntensity;
                const clampedRatio = Math.max(0.5, Math.min(1.5, ratio));
                currentRadiusPx *= clampedRatio;
            } else {
                // 如果当前未达标，但预测达标了，进行估算
                if (intensity > threshold) {
                    const estDeg = 0.5 + (intensity - threshold) * 0.015;
                    currentRadiusPx = estDeg * pxPerDeg * 0.7;
                } else {
                    currentRadiusPx = 5; // 未达标极小半径
                }
            }

            const jitter = 1.0 + (Math.sin(hour * 2.5) * 0.1) + ((Math.random() - 0.5) * 0.15);
            const jitteredRadius = currentRadiusPx * jitter;

            // 误差模型
            const errorKm = 40 + (hour * 5.5);
            const sigmaPx = (errorKm / 111.32) * pxPerDeg * 0.7; 
            
            // [关键] 强度置信度 (针对不同阈值)
            // 只有当强度显著超过 threshold 时，概率才高
            const zScore = (intensity - threshold) / (5 + hour * 0.25);
            const probConfidence = 1.0 / (1.0 + Math.exp(-1.5 * zScore));
            
            // 64kt 的时间衰减通常更快，因为不确定性更高
            const decayRate = threshold === 64 ? 150 : 200;
            const timeDecay = Math.max(0.0, 1.0 - (hour / decayRate));
            
            const maxProb = probConfidence * timeDecay * 100;

            if (maxProb < 1) continue;

            const influenceRad = jitteredRadius + sigmaPx * 2.5;
            const gx = px * scaleX;
            const gy = py * scaleY;
            const gRad = influenceRad * scaleX;

            const minGX = Math.max(0, Math.floor(gx - gRad));
            const maxGX = Math.min(gridW - 1, Math.ceil(gx + gRad));
            const minGY = Math.max(0, Math.floor(gy - gRad));
            const maxGY = Math.min(gridH - 1, Math.ceil(gy + gRad));

            const sigmaSq2 = 2 * sigmaPx * sigmaPx;

            for (let j = minGY; j <= maxGY; j++) {
                const idx = j * gridW;
                const cellY = (j / gridH) * height;
                const dy = cellY - py;
                const dy2 = dy * dy;

                for (let i = minGX; i <= maxGX; i++) {
                    const cellX = (i / gridW) * width;
                    const dx = cellX - px;
                    const dist = Math.sqrt(dx * dx + dy2);

                    const effectiveDist = Math.max(0, dist - jitteredRadius);
                    let prob = Math.exp(-(effectiveDist * effectiveDist) / sigmaSq2) * maxProb;

                    const noise = (pseudoRandom(i + k, j + s) - 0.5) * 8.0; 
                    if (prob > 3) prob += noise;

                    if (prob > values[idx + i]) {
                        values[idx + i] = prob;
                    }
                }
            }
        }
    }

    // --- 6. 绘制 ---
    const thresholds = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    const colors = [
        "rgba(255,255,255,0)", 
        "#008000", "#32cd32", "#adff2f", "#ffff00", 
        "#ffd700", "#ffa500", "#ff4500", "#ff0000", 
        "#8b0000", "#800080"
    ];

    const contours = d3.contours()
        .size([gridW, gridH])
        .thresholds(thresholds)
        (values);

    const transform = d3.geoTransform({
        point: function(x, y) {
            this.stream.point(x * (width / gridW), y * (height / gridH));
        }
    });
    const contourPath = d3.geoPath().projection(transform).context(ctx);

    contours.forEach((geometry, i) => {
        ctx.beginPath();
        contourPath(geometry);
        ctx.fillStyle = colors[i + 1] || colors[colors.length - 1];
        ctx.fill();
        if (thresholds[i] === 70) {
            ctx.lineWidth = 2; // 稍微加粗
            ctx.strokeStyle = "rgba(0, 0, 255, 0.7)"; // 使用半透明黑色，增强对比度
            ctx.setLineDash([8, 4]); // 设置虚线样式：实线8px，间隔4px
            ctx.stroke(); // 描边
            
            // 重置样式，以免影响后续绘制
            ctx.setLineDash([]); 
            ctx.lineWidth = 1;
        }
    });

    // 绘制陆地
    ctx.beginPath();
    ctx.fillStyle = "#ffffff"; 
    ctx.strokeStyle = "black";
    ctx.lineWidth = 1.0;
    pathGenerator(worldData);
    ctx.fill();
    ctx.stroke();

    // 绘制预测路径
    const trackCoords = [];
    let lastL = track[0][0];
    track.forEach(p => {
        let l = p[0];
        while (l - lastL > 180) l -= 360;
        while (l - lastL < -180) l += 360;
        lastL = l;
        trackCoords.push([l, p[1]]);
    });

    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    const feature = { type: "LineString", coordinates: trackCoords };
    pathGenerator(feature);
    ctx.stroke();
    ctx.setLineDash([]);

    // 标题
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, 70);
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, width, 70);

    ctx.fillStyle = "black";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    const year = new Date().getFullYear();
    const month = (cyclone.currentMonth || 8) - 1; 
    const startDate = new Date(Date.UTC(year, month, 1));
    startDate.setUTCHours(startDate.getUTCHours() + currentAge);
    const dateStr = startDate.toISOString().replace("T", " ").substring(0, 16) + ":00"; 

    ctx.font = "bold 28px Arial";
    // [动态标题]
    const name = (cyclone.name || "NONAME").toUpperCase();
    ctx.fillText(`${threshold} kt Wind Speed Probabilities (${name})`, width / 2, 25);
    ctx.font = "20px Arial";
    ctx.fillText(`For the 72 hours (3.0 days) from ${dateStr}`, width / 2, 53);
    ctx.font = "900 32px 'Inter', sans-serif"; // 使用粗壮的现代字体
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)"; // 低透明度黑色
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("STORM_INC®", width - 20, height - 10);
    drawProbabilityLegend(ctx, width, height, colors, thresholds);

    return canvas;
}

// 辅助函数
function drawProbabilityLegend(ctx, width, height, colors, thresholds) {
    const legW = 30;
    const legH = 500;
    const legX = width - 60;
    const legY = (height - legH) / 2;

    ctx.save();
    ctx.font = "bold 18px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    ctx.strokeStyle = "black";
    ctx.lineWidth = 1;
    ctx.strokeRect(legX, legY, legW, legH);

    const stepH = legH / (colors.length - 1); 

    for (let i = 1; i < colors.length; i++) {
        const y = legY + legH - (i * stepH);
        ctx.fillStyle = colors[i];
        ctx.fillRect(legX, y, legW, stepH);
        ctx.beginPath();
        ctx.moveTo(legX, y);
        ctx.lineTo(legX + legW, y);
        ctx.stroke();
        ctx.fillStyle = "black";
        const val = thresholds[i-1];
        if (val) ctx.fillText(val, legX + legW + 8, y + stepH);
    }
    ctx.fillText("99", legX + legW + 8, legY + 10);
    ctx.restore();
}

// --- [新增] 站点历史数据绘图函数 (折线 + 风羽 + 交互) ---
export function drawStationGraph(containerId, historyData, type = 'wind') {
    const container = d3.select(containerId);
    container.selectAll("*").remove(); // 清空旧图表

    if (!historyData || historyData.length === 0) return;

    // 1. 设置尺寸与边距
    const rect = container.node().getBoundingClientRect();
    const margin = { top: 40, right: 30, bottom: 30, left: 40 }; 
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${rect.width} ${rect.height}`)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // 2. X轴 (时间)
    const x = d3.scaleLinear()
        .domain(d3.extent(historyData, d => d.hour))
        .range([0, width]);

    svg.append("g")
        .attr("transform", `translate(0,${height})`)
        .attr("color", "#94a3b8") 
        .call(d3.axisBottom(x).ticks(5).tickFormat(d => `+${d}h`));

    // 3. Y轴与折线 (根据类型)
    let y, color, unit;
    if (type === 'wind') {
        const maxWind = d3.max(historyData, d => d.wind) || 10;
        y = d3.scaleLinear()
            .domain([0, Math.max(30, maxWind * 1.1)])
            .range([height, 0]);
        color = "#22d3ee"; // Cyan
        unit = "KT";
    } else {
        const minP = d3.min(historyData, d => d.pressure);
        const maxP = d3.max(historyData, d => d.pressure);
        // 稍微放宽一点上下限，让图表不至于贴边
        y = d3.scaleLinear()
            .domain([minP - 2, maxP + 2])
            .range([height, 0]);
        color = "#facc15"; // Yellow
        unit = "hPa";
    }

    svg.append("g")
        .attr("color", "#94a3b8")
        .call(d3.axisLeft(y).ticks(5));

    // 4. 绘制折线 (硬朗风格)
    const line = d3.line()
        .x(d => x(d.hour))
        .y(d => y(type === 'wind' ? d.wind : d.pressure))
        .curve(d3.curveLinear); // [修改] 使用线性插值 (取消平滑)

    // 绘制线条背景阴影 (可选，增加一点层次感)
    svg.append("path")
        .datum(historyData)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 4)
        .attr("stroke-opacity", 0.1)
        .attr("d", line);

    // 绘制主线条
    svg.append("path")
        .datum(historyData)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 2)
        .attr("d", line);

    // 5. 绘制风羽 (仅 Wind 模式)
    if (type === 'wind') {
        const step = Math.max(1, Math.floor(historyData.length / (width / 40)));
        const barbData = historyData.filter((d, i) => i % step === 0);
        const barbGroup = svg.append("g").attr("class", "wind-barbs");

        barbData.forEach(d => {
            const angleRad = Math.atan2(-d.v, d.u);
            const angleDeg = angleRad * (180 / Math.PI); 
            const bx = x(d.hour);
            const by = -15;
            const speed = d.wind;
            const scale = 0.8; 

            const g = barbGroup.append("g")
                .attr("transform", `translate(${bx}, ${by}) rotate(${angleDeg}) scale(${scale})`);

            g.append("line")
                .attr("x1", 0).attr("y1", 0).attr("x2", -20).attr("y2", 0)
                .attr("stroke", "#64748b").attr("stroke-width", 1.5);

            let rem = Math.round(speed / 5) * 5; 
            let pos = -20; 

            while (rem >= 50) {
                g.append("path").attr("d", `M${pos},0 L${pos+5},-10 L${pos+10},0`).attr("fill", "#64748b");
                pos += 12; rem -= 50;
            }
            while (rem >= 10) {
                g.append("line").attr("x1", pos).attr("y1", 0).attr("x2", pos + 3).attr("y2", -8).attr("stroke", "#64748b").attr("stroke-width", 1.5);
                pos += 5; rem -= 10;
            }
            if (rem >= 5) {
                g.append("line").attr("x1", pos).attr("y1", 0).attr("x2", pos + 1.5).attr("y2", -4).attr("stroke", "#64748b").attr("stroke-width", 1.5);
            }
        });
    }

    // --- [新增] 交互层 (Interaction) ---
    
    // 创建交互用的 Focus Group
    const focus = svg.append("g")
        .attr("class", "focus")
        .style("display", "none");

    // 垂直辅助线
    focus.append("line")
        .attr("class", "hover-line")
        .attr("y1", 0)
        .attr("y2", height)
        .style("stroke", "#94a3b8")
        .style("stroke-width", 1)
        .style("stroke-dasharray", "3,3")
        .style("opacity", 0.7);

    // 数据点圆圈
    focus.append("circle")
        .attr("r", 4)
        .style("fill", "#1e293b") // Slate-800 背景
        .style("stroke", color)
        .style("stroke-width", 2);

    // 文本标签背景
    focus.append("rect")
        .attr("class", "tooltip-bg")
        .attr("width", 70)
        .attr("height", 20)
        .attr("rx", 3)
        .attr("ry", 3)
        .style("fill", "rgba(0,0,0,0.7)")
        .style("pointer-events", "none"); // 防止遮挡鼠标

    // 文本标签
    const focusText = focus.append("text")
        .attr("x", 0)
        .attr("y", -10)
        .style("fill", "white")
        .style("font-size", "10px")
        .style("font-family", "Monospace")
        .style("font-weight", "bold")
        .style("text-anchor", "middle");

    // 透明矩形用于捕获鼠标事件
    svg.append("rect")
        .attr("class", "overlay")
        .attr("width", width)
        .attr("height", height)
        .style("fill", "none")
        .style("pointer-events", "all")
        .on("mouseover", () => focus.style("display", null))
        .on("mouseout", () => focus.style("display", "none"))
        .on("mousemove", mousemove);

    // 二分查找器
    const bisect = d3.bisector(d => d.hour).left;

    function mousemove(event) {
        // 1. 获取鼠标对应的 X 轴数值 (时间)
        const x0 = x.invert(d3.pointer(event)[0]);
        
        // 2. 在数组中查找最近的数据点
        const i = bisect(historyData, x0, 1);
        const d0 = historyData[i - 1];
        const d1 = historyData[i];
        
        // 边界处理
        let d = d0;
        if (d1 && d0) {
            d = x0 - d0.hour > d1.hour - x0 ? d1 : d0;
        } else if (d1) {
            d = d1;
        }

        if (!d) return;

        // 3. 移动 Focus 元素
        const posX = x(d.hour);
        const val = type === 'wind' ? d.wind : d.pressure;
        const posY = y(val);

        focus.attr("transform", `translate(${posX},${posY})`);
        
        // 更新垂直线位置 (因为 transform 移动了整个 group，垂直线需要反向修正 Y)
        focus.select(".hover-line")
            .attr("y1", -posY) // 延伸到顶部
            .attr("y2", height - posY); // 延伸到底部

        // 更新文本
        focusText.text(`T+${d.hour}h: ${Math.round(val)}${unit}`);
        
        // 动态调整 Tooltip 位置，防止超出右边界
        const textWidth = 80;
        if (posX + textWidth/2 > width) {
            focus.select("rect").attr("x", -textWidth);
            focusText.attr("x", -textWidth/2);
        } else {
            focus.select("rect").attr("x", 5);
            focusText.attr("x", 40); // 居中
        }
        // 垂直位置微调
        focus.select("rect").attr("y", -25);
        focusText.attr("y", -11);
    }
}

function addNoise(val, magnitude, seed) {
    return val + (Math.sin(seed * 12.9898) * magnitude);
}

// [核心] 渲染气旋相空间图 (Cyclone Phase Space - CPS)
export function renderPhaseSpace(cyclone, globalTemp = 289) { // <--- [修改] 接收 globalTemp
    const width = 800;
    const height = 600;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // --- 1. 背景 ---
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const chartX = 60;
    const chartY = 40;
    const chartW = width - chartX - 180;
    const chartH = height - chartY - 50;

    // --- 2. 物理参数反演 ---
    const track = cyclone.track;
    const dataPoints = [];
    let rawPoints = [];

    const month = cyclone.currentMonth || 8;

    track.forEach((p, i) => {
        const lat = p[1];
        const lon = p[0]; // 需要经度来查 SST
        const intensity = p[2];
        const isExtra = p[4];
        const isSub = p[6];
        const ageHours = i * 3;

        // [新增] 获取该点的海温 SST
        const sst = getSST(lat, lon, month, globalTemp);

        // ==========================================
        // A. Parameter B (不对称度)
        // ==========================================
        
        let B = 35.0 - (sst / 1.0); 

        if (!isExtra) {
            const isNH = lat >= 0;
            let seasonPhase = Math.cos((month - 1) / 12 * 2 * Math.PI);
            if (!isNH) seasonPhase *= -1;
            const jetStrength = 1.0 + (seasonPhase * 0.3);

            const tropicalThreshold = 15;
            let effectiveLat = Math.max(0, Math.abs(lat) - tropicalThreshold);
            let latForcing = (Math.pow(effectiveLat, 1.8) / 26.0) * jetStrength;
            
            let ageFactor = 1.0;
            if (ageHours < 48) ageFactor = Math.pow(ageHours / 48, 1.5); 
            latForcing *= ageFactor;

            const stabilityFactor = 1.0 + 0.0 * Math.pow(intensity / 40, 1.5);
            B += latForcing / stabilityFactor;
            
            if (isSub) B = Math.max(B, 15 + Math.random() * 5);

        } else {
            const frontSeasonality = 1.0 + (Math.cos((month - 1) / 12 * 2 * Math.PI) * (lat>=0?1:-1) * 0.2);
            const frontalContrast = 30 * Math.tanh((Math.abs(lat) - 20) / 15); 
            B = 20 + (frontalContrast * frontSeasonality); 
        }

        B = addNoise(B, 1.5, i);
        B = Math.max(0, Math.min(60, B));

        // ==========================================
        // B. Parameter -Vt (暖心) - [SST 核心修正]
        // ==========================================
        
        let Vt = 0;

        if (!isExtra) {
            // 基础暖心 (由强度驱动)
            let baseVt = (intensity * 1.4) - (28 - sst) * 10.0;

            // [新增] SST 热力修正系数 (Thermal Support Factor)
            
            // 计算公式：SST每下降1度，支持率线性下降
            // (sst - 18) / 16  => 26度时为1，18度时为0
            let sstFactor = Math.max(0.3, Math.min(1.1, (sst - 18) / 16));

            // 如果是亚热带，本身就是浅暖心，SST影响稍小但依然存在
            if (isSub) sstFactor *= 0.8;

            Vt = baseVt * sstFactor;

        } else {
            // 温带阶段：冷平流侵蚀 + SST 冷却
            // 如果底下水还是很热 (比如 Gulf Stream)，暖心消亡得慢一点
            const coldAdvection = (Math.abs(lat) - 20 * 0.6 * (1 + Math.sin((month - 2) / 12 * 2 * Math.PI))) * 4.0;
            const sstDecay = Math.max(0, (26 - sst) * 2.0); // 水越冷，扣分越多
            
            Vt = (intensity * 1.0) - coldAdvection - sstDecay;
            if (Vt < -150) Vt = -150;
        }

        Vt = addNoise(Vt, 3.0, i * 2);

        rawPoints.push({ x: B, y: Vt, isExtra, isSub, intensity, hour: ageHours });
    });

    // 平滑处理 (3点移动平均)
    for (let i = 0; i < rawPoints.length; i++) {
        let sumX = 0, sumY = 0, count = 0;
        for (let j = -1; j <= 1; j++) {
            if (rawPoints[i+j]) {
                sumX += rawPoints[i+j].x;
                sumY += rawPoints[i+j].y;
                count++;
            }
        }
        dataPoints.push({
            ...rawPoints[i],
            x: sumX / count,
            y: sumY / count
        });
    }

    const currentData = dataPoints[dataPoints.length - 1];

    // --- 3. 绘图 (坐标系 & 网格) ---
    const minB = -10, maxB = 60;
    const minVt = -150, maxVt = 250; 

    const scaleX = val => chartX + ((val - minB) / (maxB - minB)) * chartW;
    const scaleY = val => chartY + chartH - ((val - minVt) / (maxVt - minVt)) * chartH;

    // 背景色块
    ctx.fillStyle = "#fff1f2"; // Deep Warm
    ctx.fillRect(scaleX(minB), scaleY(maxVt), scaleX(10) - scaleX(minB), scaleY(0) - scaleY(maxVt));
    ctx.fillStyle = "#fffbeb"; // Shallow/Hybrid
    ctx.fillRect(scaleX(10), scaleY(maxVt), scaleX(maxB) - scaleX(10), scaleY(0) - scaleY(maxVt));
    ctx.fillStyle = "#f0f9ff"; // Cold
    ctx.fillRect(scaleX(minB), scaleY(0), scaleX(maxB) - scaleX(minB), scaleY(minVt) - scaleY(0));

    // 网格线
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#e2e8f0";
    ctx.font = "10px Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let v = -150; v <= 250; v += 50) {
        let y = scaleY(v);
        ctx.beginPath(); ctx.moveTo(chartX, y); ctx.lineTo(chartX + chartW, y); ctx.stroke();
        ctx.fillStyle = "#64748b"; ctx.fillText(v, chartX - 5, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let b = 0; b <= 60; b += 10) {
        let x = scaleX(b);
        ctx.beginPath(); ctx.moveTo(x, chartY); ctx.lineTo(x, chartY + chartH); ctx.stroke();
        ctx.fillStyle = "#64748b"; ctx.fillText(b, x, chartY + chartH + 5);
    }

    // 主轴
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(scaleX(10), chartY); ctx.lineTo(scaleX(10), chartY + chartH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(chartX, scaleY(0)); ctx.lineTo(chartX + chartW, scaleY(0)); ctx.stroke();

    // 标签
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "left";
    ctx.fillStyle = "#be123c"; ctx.fillText("DEEP WARM CORE", chartX + 10, chartY + 15);
    ctx.textAlign = "right";
    ctx.fillStyle = "#b45309"; ctx.fillText("SHALLOW WARM / HYBRID", chartX + chartW - 10, chartY + 15);
    ctx.fillStyle = "#0369a1"; ctx.fillText("COLD CORE (EXTRATROPICAL)", chartX + chartW - 10, chartY + chartH - 15);

    ctx.save();
    ctx.translate(15, chartY + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = "#000";
    ctx.fillText("Parameter -V_T : Thermal Wind (Lower-Trop)", 0, 0);
    ctx.restore();
    ctx.textAlign = "center";
    ctx.fillText("Parameter B : Thermal Asymmetry", chartX + chartW / 2, height - 10);

    // --- 4. 绘制轨迹 ---
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;

    for (let i = 0; i < dataPoints.length - 1; i++) {
        const p1 = dataPoints[i];
        const p2 = dataPoints[i+1];
        
        ctx.beginPath();
        ctx.moveTo(scaleX(p1.x), scaleY(p1.y));
        ctx.lineTo(scaleX(p2.x), scaleY(p2.y));

        if (p2.y < 0) ctx.strokeStyle = "#2563eb"; 
        else if (p2.x > 10) ctx.strokeStyle = "#f59e0b"; 
        else ctx.strokeStyle = "#dc2626"; 
        
        if (p2.isExtra) ctx.strokeStyle = "#3b82f6"; 

        ctx.stroke();
        
        if (i > 0 && i % 8 === 0) {
            const mx = scaleX(p1.x);
            const my = scaleY(p1.y);
            ctx.fillStyle = "#000";
            ctx.beginPath(); ctx.arc(mx, my, 2.5, 0, Math.PI*2); ctx.fill();
            const d = Math.floor(i / 8);
            ctx.font = "9px Arial";
            ctx.fillText(`D${d}`, mx + 6, my - 6);
        }
    }

    // A/Z
    if (dataPoints.length > 0) {
        ctx.fillStyle = "#000";
        ctx.font = "bold 16px Arial";
        ctx.fillText("A", scaleX(dataPoints[0].x), scaleY(dataPoints[0].y));
        
        const lastP = dataPoints[dataPoints.length - 1];
        ctx.shadowBlur = 5; ctx.shadowColor = "rgba(255,255,255,1)";
        ctx.beginPath(); ctx.arc(scaleX(lastP.x), scaleY(lastP.y), 6, 0, Math.PI*2); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px Arial";
        ctx.textBaseline = "middle";
        ctx.fillText("Z", scaleX(lastP.x), scaleY(lastP.y));
    }

    // --- 5. 右侧状态栏 ---
    const infoX = chartX + chartW + 20;
    const infoY = chartY;
    
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    
    ctx.fillStyle = "#64748b";
    ctx.font = "bold 12px 'JetBrains Mono'";
    ctx.fillText("CURRENT STATUS", infoX, infoY);

    let phaseName = "TROPICAL";
    let phaseColor = "#dc2626";
    if (currentData.y < 0) { phaseName = "COLD CORE"; phaseColor = "#2563eb"; }
    else if (currentData.x > 10) { phaseName = "SUBTROPICAL"; phaseColor = "#d97706"; }

    ctx.fillStyle = phaseColor;
    ctx.fillRect(infoX, infoY + 20, 4, 35);
    
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 20px 'JetBrains Mono'";
    ctx.fillText(phaseName, infoX + 10, infoY + 20);
    
    ctx.fillStyle = "#64748b";
    ctx.font = "11px 'JetBrains Mono'";
    ctx.fillText(`B (Asym): ${currentData.x.toFixed(1)}`, infoX + 10, infoY + 45);
    ctx.fillText(`-V_T: ${currentData.y.toFixed(1)}`, infoX + 10, infoY + 60);
    
    // 版权标
    ctx.textAlign = "right";
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText("STORM_INC®", width - 10, height - 10);

    return canvas;
}

function renderNewsBackground(ctx, projection, width, height, worldData) {
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    // 1. 海洋
    ctx.fillStyle = "#0f3460";
    ctx.fillRect(0, 0, width, height);

    // 2. 陆地
    ctx.fillStyle = "#16213e";
    ctx.strokeStyle = "#4ecca3";
    ctx.lineWidth = 1.5;
    pathGenerator(worldData);
    ctx.fill();
    ctx.stroke();

    // 3. 经纬网
    const graticule = d3.geoGraticule().step([5, 5]);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    graticule.lines().forEach(l => {
        pathGenerator(l);
        ctx.stroke();
        ctx.beginPath();
    });

    // 4. 边缘标签
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "12px 'JetBrains Mono'";
    ctx.textBaseline = "middle";

    const tl = projection.invert([0, 0]) || [-180, 90];
    const br = projection.invert([width, height]) || [180, -90];

    // 纬度标签 (左边缘)
    const startLat = Math.floor(Math.min(tl[1], br[1]) / 5) * 5;
    const endLat = Math.ceil(Math.max(tl[1], br[1]) / 5) * 5;
    const refLonLeft = tl[0]; 

    ctx.textAlign = "left";
    for (let lat = startLat; lat <= endLat; lat += 5) {
        const p = projection([refLonLeft, lat]);
        if (p && p[1] > 20 && p[1] < height - 20) {
            ctx.fillText(`${lat}°N`, 10, p[1]);
        }
    }

    // 经度标签 (下边缘)
    const centerLon = (tl[0] + br[0]) / 2;
    const spanEstimate = 360 / (projection.scale() / 100); 
    const scanStart = Math.floor((centerLon - spanEstimate) / 5) * 5;
    const scanEnd = Math.ceil((centerLon + spanEstimate) / 5) * 5;
    const refLatBot = br[1];

    ctx.textAlign = "center";
    for (let lon = scanStart; lon <= scanEnd; lon += 5) {
        const p = projection([lon, refLatBot]);
        if (p && p[0] > 50 && p[0] < width - 50) {
            let displayLon = lon;
            while (displayLon > 180) displayLon -= 360;
            while (displayLon < -180) displayLon += 360;
            const suffix = displayLon >= 0 ? 'E' : 'W';
            ctx.fillText(`${Math.abs(displayLon)}°${suffix}`, p[0], height - 25);
        }
    }
}

// [核心] 新闻模式动画引擎 (v12.0 Clean & Optimized)
export function startNewsAnimation(canvas, worldData, cyclone, pathForecasts, basin, simulationCount, pressureSystems, currentMonth, globalTemp, globalShear) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // --- 1. 数据解包 ---
    const unwrapLon = (lon, refLon) => {
        let diff = lon - refLon;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return refLon + diff;
    };

    if (!cyclone.track || cyclone.track.length === 0) return null;

    const refLon = cyclone.track[0][0];
    const fullTrackUnwrapped = cyclone.track.map(p => [unwrapLon(p[0], refLon), p[1], p[2]]);

    let forecastModels = [];
    if (pathForecasts && pathForecasts.length > 0) {
        forecastModels = pathForecasts.map(model => {
            return {
                ...model,
                track: model.track.map(p => [unwrapLon(p[0], refLon), p[1], p[2]])
            };
        });
    }

    // --- 2. 初始投影 (Overview) ---
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const allPoints = [...fullTrackUnwrapped];
    forecastModels.forEach(m => m.track.forEach(p => allPoints.push(p)));

    allPoints.forEach(p => {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
    });

    const initCenterLon = (minLon + maxLon) / 2;
    const initCenterLat = (minLat + maxLat) / 2;
    const spanLon = Math.max(10, maxLon - minLon); 
    const spanLat = Math.max(8, maxLat - minLat);

    const padding = 350; 
    const initScaleX = (width - padding) / (spanLon * Math.PI / 180);
    const initScaleY = (height - padding) / (spanLat * Math.PI / 180);
    const initScale = Math.min(initScaleX, initScaleY);

    const projection = d3.geoEquirectangular()
        .rotate([-initCenterLon, 0]) 
        .center([0, initCenterLat]) 
        .translate([width / 2, height / 2])
        .scale(initScale);
    
    // --- 3. 预渲染 Loop 背景 (Offscreen Canvas) ---
    // 关键优化：只画一次复杂的地图
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = width;
    bgCanvas.height = height;
    const bgCtx = bgCanvas.getContext('2d');
    renderNewsBackground(bgCtx, projection, width, height, worldData);

    // --- 4. 预测锥计算 ---
    let boundaryPoints = [];
    if (forecastModels.length > 0) {
        const maxSteps = d3.max(forecastModels, m => m.track.length);
        const stepData = [];
        for (let i = 0; i < maxSteps; i++) {
            const pointsAtStep = [];
            forecastModels.forEach(m => { if (m.track[i]) pointsAtStep.push(m.track[i]); });
            if (pointsAtStep.length === 0) continue;
            const avgLon = d3.mean(pointsAtStep, p => p[0]);
            const avgLat = d3.mean(pointsAtStep, p => p[1]);
            const stdDev = d3.deviation(pointsAtStep, p => {
                const dx = (p[0] - avgLon) * Math.cos(avgLat * Math.PI / 180);
                const dy = p[1] - avgLat;
                return Math.sqrt(dx*dx + dy*dy);
            }) || 0;
            const spreadFactor = 0.05 + i * 0.12; 
            const radiusDeg = Math.max(0.2, spreadFactor + (stdDev * 1.5));
            stepData.push({ lon: avgLon, lat: avgLat, r: radiusDeg });
        }
        for (let i = 0; i < stepData.length; i++) {
            const curr = stepData[i];
            const cosL = Math.cos(curr.lat * Math.PI / 180);
            let angle = 0;
            const prev = i > 0 ? stepData[i-1] : null;
            const next = i < stepData.length - 1 ? stepData[i+1] : null;
            
            if (prev && next) angle = Math.atan2(next.lat - prev.lat, (next.lon - prev.lon) * cosL);
            else if (next) angle = Math.atan2(next.lat - curr.lat, (next.lon - curr.lon) * cosL);
            else if (prev) angle = Math.atan2(curr.lat - prev.lat, (curr.lon - prev.lon) * cosL);
            
            const normal = angle + Math.PI / 2;
            const left = [curr.lon + (curr.r * Math.cos(normal) / cosL), curr.lat + (curr.r * Math.sin(normal))];
            const right = [curr.lon + (curr.r * Math.cos(normal + Math.PI) / cosL), curr.lat + (curr.r * Math.sin(normal + Math.PI))];
            
            const pCenter = projection([curr.lon, curr.lat]);
            const pLeft = projection(left);
            const pRight = projection(right);
            if (pCenter && pLeft && pRight) {
                const screenR = Math.hypot(pLeft[0]-pCenter[0], pLeft[1]-pCenter[1]);
                boundaryPoints.push({ left: pLeft, right: pRight, center: pCenter, radius: screenR });
            }
        }
    }

    // --- 5. 动画状态机 ---
    let animState = 'LOOP';
    
    // Loop Vars
    let frame = 0;
    const totalHistoryFrames = 180; 
    const forecastFadeFrames = 60;
    const holdFrames = 540;
    const totalFrames = totalHistoryFrames + forecastFadeFrames + holdFrames;
    let loopCount = 0;

    // Zoom Vars
    let zoomFrame = 0;
    const zoomDuration = 120; 
    const maxZoomScale = 2.5;
    const lastTrackPoint = fullTrackUnwrapped[fullTrackUnwrapped.length - 1];
    const initialCycloneScreenPos = projection(lastTrackPoint); // 气旋在初始视图中的屏幕坐标

    // Streamline Vars
    let streamlineBgCanvas = null;
    const NUM_PARTICLES = 1500; 
    const particles = [];
    
    // Common Vars
    const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
    const basinCode = basinMap[basin] || 'XX';
    const cycloneNumStr = String(simulationCount).padStart(2, '0');
    const displayName = cyclone.name ? cyclone.name.toUpperCase() : `${basinCode} ${cycloneNumStr}`;
    const rotationDir = cyclone.lat < 0 ? 1 : -1; 
    const year = new Date().getFullYear();
    const monthIdx = (cyclone.currentMonth || 8) - 1; 
    const startDay = 1;
    let animationId = null;

    const initParticle = (p) => {
        p.x = Math.random() * width;
        p.y = Math.random() * height;
        p.age = Math.random() * 50;
        p.maxAge = 60 + Math.random() * 60; 
        return p;
    };

    const easeInOut = (t) => t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    // --- 渲染循环 ---
    const render = () => {
        ctx.clearRect(0, 0, width, height);

        if (animState === 'LOOP') {
            // ========================
            // A. Loop 阶段 (复用静态背景)
            // ========================
            ctx.drawImage(bgCanvas, 0, 0);

            let historyProgress = Math.min(1, frame / totalHistoryFrames);
            let forecastAlpha = 0;
            if (frame > totalHistoryFrames) {
                forecastAlpha = Math.min(1, (frame - totalHistoryFrames) / forecastFadeFrames);
            }

            // 1. 预测层
            if (boundaryPoints.length > 0 && forecastAlpha > 0) {
                ctx.save();
                ctx.globalAlpha = forecastAlpha;
                
                // 锥体
                if (boundaryPoints.length >= 2) {
                    ctx.beginPath();
                    ctx.moveTo(boundaryPoints[0].left[0], boundaryPoints[0].left[1]);
                    for (let i = 1; i < boundaryPoints.length; i++) ctx.lineTo(boundaryPoints[i].left[0], boundaryPoints[i].left[1]);
                    const lastBP = boundaryPoints[boundaryPoints.length - 1];
                    const startA = Math.atan2(lastBP.left[1] - lastBP.center[1], lastBP.left[0] - lastBP.center[0]);
                    const endA = Math.atan2(lastBP.right[1] - lastBP.center[1], lastBP.right[0] - lastBP.center[0]);
                    ctx.arc(lastBP.center[0], lastBP.center[1], lastBP.radius, startA, endA, false);
                    for (let i = boundaryPoints.length - 2; i >= 0; i--) ctx.lineTo(boundaryPoints[i].right[0], boundaryPoints[i].right[1]);
                    ctx.closePath();
                    ctx.fillStyle = "rgba(255, 255, 255, 0.15)"; ctx.fill();
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)"; ctx.lineWidth = 1;
                    ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
                }

                // 节点与标签
                if (forecastModels.length > 0) {
                    const mainModel = forecastModels[0]; 
                    ctx.beginPath(); ctx.strokeStyle = "white"; ctx.lineWidth = 2;
                    mainModel.track.forEach((p, i) => {
                        const pos = projection(p);
                        if (pos) { if (i === 0) ctx.moveTo(pos[0], pos[1]); else ctx.lineTo(pos[0], pos[1]); }
                    });
                    ctx.stroke();

                    ctx.fillStyle = "white";
                    mainModel.track.forEach((p, idx) => {
                        if (idx === 0 || idx % 8 !== 0) return; 
                        const pos = projection(p);
                        if (pos) { ctx.beginPath(); ctx.arc(pos[0], pos[1], 4, 0, Math.PI*2); ctx.fill(); }
                    });

                    // 终点日期
                    const lastIdx = mainModel.track.length - 1;
                    const lastP = mainModel.track[lastIdx];
                    const projP = projection(lastP);
                    if (projP) {
                        const currentHours = (fullTrackUnwrapped.length - 1) * 3;
                        const forecastHours = lastIdx * 3; 
                        const totalHours = currentHours + forecastHours;
                        const finalDate = new Date(Date.UTC(year, monthIdx, startDay));
                        finalDate.setUTCHours(finalDate.getUTCHours() + totalHours);
                        const fDD = String(finalDate.getUTCDate()).padStart(2, '0');
                        const fHH = String(finalDate.getUTCHours()).padStart(2, '0');
                        const finalDateText = `${fDD}/${fHH}Z`;

                        ctx.font = "bold 14px 'JetBrains Mono'";
                        const fMetrics = ctx.measureText(finalDateText);
                        const fBoxW = fMetrics.width + 16;
                        const fLabelY = projP[1] - 30;
                        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
                        ctx.strokeStyle = "rgba(100, 200, 255, 0.5)";
                        ctx.lineWidth = 1;
                        ctx.beginPath(); ctx.roundRect(projP[0] - fBoxW/2, fLabelY - 10, fBoxW, 20, 4);
                        ctx.fill(); ctx.stroke();
                        ctx.fillStyle = "#bae6fd"; ctx.fillText(finalDateText, projP[0], fLabelY);
                    }
                }
                ctx.restore();
            }

            // 2. 历史路径
            const currentIndexFloat = (fullTrackUnwrapped.length - 1) * historyProgress;
            const currentIndex = Math.floor(currentIndexFloat);
            
            if (fullTrackUnwrapped.length > 0) {
                ctx.beginPath(); ctx.strokeStyle = "white"; ctx.lineWidth = 4;
                ctx.lineCap = "round"; ctx.lineJoin = "round";
                for (let i = 0; i < currentIndex; i++) {
                    const p1 = projection(fullTrackUnwrapped[i]);
                    const p2 = projection(fullTrackUnwrapped[i+1]);
                    if (p1 && p2) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
                }
                ctx.stroke();

                const headPoint = fullTrackUnwrapped[currentIndex];
                const headProj = projection(headPoint);
                
                if (headProj) {
                    const pulse = 10 + Math.sin(frame * 0.2) * 5;
                    ctx.beginPath(); ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
                    ctx.arc(headProj[0], headProj[1], 30 + pulse, 0, Math.PI*2); ctx.fill();

                    ctx.font = '900 32px "Font Awesome 6 Free"';
                    ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    ctx.save();
                    ctx.translate(headProj[0], headProj[1]);
                    ctx.rotate(frame * 0.1 * rotationDir); 
                    ctx.fillText('\uf751', 0, 0); 
                    ctx.restore();

                    // 标签
                    const hoursElapsed = currentIndex * 3;
                    const currentDate = new Date(Date.UTC(year, monthIdx, startDay));
                    currentDate.setUTCHours(currentDate.getUTCHours() + hoursElapsed);
                    const dd = String(currentDate.getUTCDate()).padStart(2, '0');
                    const hh = String(currentDate.getUTCHours()).padStart(2, '0');
                    const dateText = `${dd}/${hh}Z`;
                    const labelText = `${displayName}  ${dateText}`;

                    ctx.save();
                    const labelX = headProj[0] + 40;
                    const labelY = headProj[1] - 40;
                    ctx.font = "bold 18px 'JetBrains Mono'";
                    const textMetrics = ctx.measureText(labelText);
                    const boxWidth = textMetrics.width + 30;
                    ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
                    ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.rect(labelX, labelY, boxWidth, 36); ctx.fill(); ctx.stroke();
                    ctx.fillStyle = "#ef4444"; ctx.fillRect(labelX, labelY, 4, 36);
                    ctx.fillStyle = "white"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
                    ctx.fillText(labelText, labelX + 15, labelY + 18);
                    ctx.restore();
                }
            }

            frame++;
            if (frame > totalFrames) {
                frame = 0;
                loopCount++;
                if (loopCount >= 4) {
                    animState = 'ZOOM';
                    zoomFrame = 0;
                }
            }

        } else if (animState === 'ZOOM') {
            // ========================
            // B. Zoom 阶段 (图像缩放优化)
            // ========================
            
            // 计算缩放进度
            const t = easeInOut(zoomFrame / zoomDuration);
            const currentScale = 1 + (maxZoomScale - 1) * t;

            // 计算视图偏移：从 屏幕中心 移动到 气旋所在位置
            // 目标是把 initialCycloneScreenPos 移动到屏幕中心
            const viewCenterX = (width / 2) * (1 - t) + initialCycloneScreenPos[0] * t;
            const viewCenterY = (height / 2) * (1 - t) + initialCycloneScreenPos[1] * t;

            ctx.save();
            
            // 变换矩阵：居中 -> 缩放 -> 移回目标点
            ctx.translate(width / 2, height / 2);
            ctx.scale(currentScale, currentScale);
            ctx.translate(-viewCenterX, -viewCenterY);
            
            // 绘制已经画好的 bgCanvas (这就是性能起飞的原因)
            // 此时是在做图片缩放，而不是复杂的矢量投影计算
            ctx.drawImage(bgCanvas, 0, 0);
            
            // 绘制气旋图标 (它需要跟随地图移动，所以也受 transform 影响)
            // 注意：我们不想让图标也被放大，所以要反向缩放图标，或者简单的接受它变大
            // 这里为了视觉冲击力，让图标跟着变大也是一种风格。
            // 但如果不想让图标变大：
            const headP = initialCycloneScreenPos;
            
            const pulse = 10 + Math.sin(Date.now() * 0.005) * 5;
            ctx.beginPath(); ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
            ctx.arc(headP[0], headP[1], 30 + pulse, 0, Math.PI*2); ctx.fill();

            ctx.font = '900 32px "Font Awesome 6 Free"';
            ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.save();
            ctx.translate(headP[0], headP[1]);
            // 保持图标持续旋转
            ctx.rotate((Date.now() / 1000) * rotationDir); 
            ctx.fillText('\uf751', 0, 0); 
            ctx.restore();

            ctx.restore(); // 恢复画布状态

            zoomFrame++;
            if (zoomFrame > zoomDuration) {
                animState = 'STREAMLINE';
                for(let k=0; k<NUM_PARTICLES; k++) particles.push(initParticle({}));
            }

        } else if (animState === 'STREAMLINE') {
            // ========================
            // C. Streamline 阶段 (高清重绘)
            // ========================
            
            // 1. 生成高清背景缓存 (仅一次)
            if (!streamlineBgCanvas) {
                streamlineBgCanvas = document.createElement('canvas');
                streamlineBgCanvas.width = width;
                streamlineBgCanvas.height = height;
                const sCtx = streamlineBgCanvas.getContext('2d');

                // 更新投影到最终状态
                const finalCenterLon = lastTrackPoint[0];
                const finalCenterLat = lastTrackPoint[1];
                const finalScale = initScale * maxZoomScale;

                projection
                    .rotate([-finalCenterLon, 0])
                    .center([0, finalCenterLat])
                    .translate([width/2, height/2])
                    .scale(finalScale);

                // 在新投影下重新生成清晰的矢量地图
                renderNewsBackground(sCtx, projection, width, height, worldData);
            }

            // 2. 绘制静态背景
            ctx.drawImage(streamlineBgCanvas, 0, 0);

            // 3. 粒子系统
            const headPoint = fullTrackUnwrapped[fullTrackUnwrapped.length - 1];
            const headProj = projection(headPoint);
            
            ctx.lineWidth = 1.2; ctx.lineCap = "round";
            
            for (let i = 0; i < particles.length; i++) {
                const p = particles[i];
                const geo = projection.invert([p.x, p.y]);
                if (!geo) { initParticle(p); continue; }
                const [lon, lat] = geo;

                const vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems, globalTemp, globalShear);
                const speedScale = 0.2; 
                p.x += vec.u * speedScale;
                p.y -= vec.v * speedScale; 
                p.age++;

                const speed = vec.magnitude;
                let alpha = 0.5;
                if (p.age < 15) alpha = p.age / 15;
                if (p.age > p.maxAge - 15) alpha = (p.maxAge - p.age) / 15;
                
                ctx.beginPath();
                const trailLen = 3.0; 
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x - vec.u * speedScale * trailLen, p.y + vec.v * speedScale * trailLen);
                
                if (speed > 48) ctx.strokeStyle = `rgba(255, 80, 80, ${alpha})`; 
                else if (speed > 23) ctx.strokeStyle = `rgba(255, 220, 100, ${alpha})`; 
                else ctx.strokeStyle = `rgba(200, 255, 255, ${alpha * 0.4})`; 

                ctx.stroke();

                if (p.age >= p.maxAge || p.x < 0 || p.x > width || p.y < 0 || p.y > height) initParticle(p);
            }

            // 4. 气旋图标 (居中)
            if (headProj) {
                ctx.font = '900 32px "Font Awesome 6 Free"';
                ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.save();
                ctx.translate(headProj[0], headProj[1]);
                ctx.rotate((Date.now() / 1000) * rotationDir);
                ctx.fillText('\uf751', 0, 0); 
                ctx.restore();
            }
            
            ctx.fillStyle = "rgba(0,0,0,0.8)";
            ctx.fillRect(width - 260, 80, 240, 40);
            ctx.fillStyle = "#4ade80";
            ctx.font = "bold 16px 'JetBrains Mono'";
            ctx.textAlign = "right";
            ctx.fillText("● LIVE WIND FIELD", width - 40, 105);
        }

        animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
        if (animationId) cancelAnimationFrame(animationId);
    };
}

export function renderStationSynopticChart(cyclone, timeIndex, worldData, pressureSystems, stationLon, stationLat, stationName) {
    const width = 1600;
    const height = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // 1. 数据准备
    // 获取当时的气旋状态
    const safeIndex = (timeIndex >= 0 && timeIndex < cyclone.track.length) ? timeIndex : cyclone.track.length - 1;
    const currentPoint = cyclone.track[safeIndex];
    const cycLon = currentPoint[0];
    const cycLat = currentPoint[1];
    const intensity = currentPoint[2];
    const size = currentPoint[5] || cyclone.circulationSize || 300;
    const basin = cyclone.basin || 'WPAC';

    // 2. 投影设置 (以站点为中心)
    // 如果没有站点坐标，兜底使用气旋中心
    const centerLon = (stationLon != null) ? stationLon : cycLon;
    const centerLat = (stationLat != null) ? stationLat : cycLat;

    // 使用球极平面投影 (Stereographic) 或 等距方位投影，适合局部天气图
    // 这里为了兼容性继续使用 Equirectangular，但放大倍数较高
    const projection = d3.geoEquirectangular()
        .rotate([-centerLon, 0])
        .center([0, centerLat])
        .scale(4000) // 局部放大，约显示 10-15 度范围
        .translate([width / 2, height / 2]);

    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    // 3. 背景绘制 (海洋/陆地)
    ctx.fillStyle = "#aed6f1"; // 浅蓝海洋
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    ctx.fillStyle = "#f9e79f"; // 浅黄陆地
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 1;
    pathGenerator(worldData);
    ctx.fill();
    ctx.stroke();

    // 4. 绘制经纬网
    ctx.beginPath();
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    pathGenerator(d3.geoGraticule().step([1, 1])()); // 1度网格
    ctx.stroke();
    ctx.setLineDash([]);

    // --- 5. [核心] 计算合成气压场 ---
    const nx = 200, ny = 150; // 网格分辨率
    const gridValues = new Float32Array(nx * ny);
    const systemsLayer = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems.lower || []);
    const centerEnvP = getPressureAt(cycLon, cycLat, systemsLayer, false);
    // 气旋参数预计算
    const Pc = windToPressure(intensity, size, basin, centerEnvP); // 中心气压
    const Rmw = 10 + size * 0.25; 

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            // 反投影获取经纬度
            const coords = projection.invert([i * width / nx, j * height / ny]);
            if (!coords) { gridValues[j * nx + i] = 1012; continue; }
            
            const [lon, lat] = coords;

            // A. 计算环境气压 (Synoptic Background)
            const P_env = getPressureAt(lon, lat, systemsLayer, false);

            // B. 计算气旋气压 (Vortex Field)
            const distKm = calculateDistance(lat, lon, cycLat, cycLon);
            // Holland 公式：P(r)
            const P_total = calculateHollandPressure(distKm, Rmw, Pc, P_env);
            gridValues[j * nx + i] = P_total;
        }
    }

    // --- 6. 绘制等压线 (Isobars) ---
    const thresholds = d3.range(880, 1040, 2); // 每 2hPa 一根
    const contours = d3.contours().size([nx, ny]).thresholds(thresholds)(gridValues);
    
    // 坐标变换器
    const transform = d3.geoTransform({
        point: function(x, y) {
            this.stream.point(x * (width / nx), y * (height / ny));
        }
    });
    const contourPath = d3.geoPath().projection(transform).context(ctx);

    contours.forEach(c => {
        const val = c.value;
        ctx.beginPath();
        contourPath(c);
        
        // 样式逻辑
        if (val % 10 === 0) {
            // 主曲线 (1000, 1010...)
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = "#2c3e50"; // 深蓝黑
        } else if (val % 4 === 0) {
            // 次级曲线
            ctx.lineWidth = 1.0;
            ctx.strokeStyle = "#566573";
        } else {
            // 细线
            ctx.lineWidth = 0.5;
            ctx.strokeStyle = "rgba(86, 101, 115, 0.5)";
        }
        
        ctx.stroke();

        // 标签 (简单处理：不做复杂的沿线标注，仅在特定位置标注)
        // 这是一个简化，真正好的等压线标注很难
    });

    // --- 7. 绘制关键要素 ---

    // A. 站点标记
    if (stationLon != null && stationLat != null) {
        const sPos = projection([stationLon, stationLat]);
        if (sPos) {
            // 靶心图标
            ctx.beginPath(); ctx.arc(sPos[0], sPos[1], 8, 0, Math.PI*2);
            ctx.fillStyle = "red"; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle="white"; ctx.stroke();
            
            // 站点名称
            ctx.fillStyle = "black";
            ctx.font = "bold 24px Arial";
            ctx.textAlign = "left";
            ctx.fillText((stationName || "STATION").toUpperCase(), sPos[0] + 15, sPos[1] + 8);
            
            // 当前气压值
            // 重新计算一下该点的气压用于显示
            const P_env = getPressureAt(stationLon, stationLat, systemsLayer, false);
            const dist = calculateDistance(stationLat, stationLon, cycLat, cycLon);
            const P_local = Math.round(calculateHollandPressure(dist, Rmw, Pc, P_env));
            
            ctx.fillStyle = "blue";
            ctx.font = "bold 20px Monospace";
            ctx.fillText(`${P_local} hPa`, sPos[0] + 15, sPos[1] + 32);
        }
    }

    // B. 气旋中心
    const cPos = projection([cycLon, cycLat]);
    if (cPos) {
        ctx.font = '900 40px "Font Awesome 6 Free"';
        ctx.fillStyle = "#c0392b";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText('\uf751', cPos[0], cPos[1]);
        
        // 标注中心气压
        ctx.fillStyle = "black";
        ctx.font = "bold 16px Arial";
        ctx.fillText(`L (${Math.round(Pc)})`, cPos[0], cPos[1] + 40);
    }

    // --- 8. 图表装饰 ---
    // 标题栏
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, 60);
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, width, 60);

    ctx.fillStyle = "black";
    ctx.textAlign = "left";
    ctx.font = "bold 24px Arial";
    ctx.textBaseline = "middle";
    ctx.fillText("LOCAL SYNOPTIC ANALYSIS (MSLP)", 20, 30);

    // 时间戳
    const year = new Date().getFullYear();
    const monthIndex = (cyclone.currentMonth || 8) - 1; 
    const currentAge = timeIndex * 3;
    const simDate = new Date(Date.UTC(year, monthIndex, 1));
    simDate.setUTCHours(simDate.getUTCHours() + currentAge);
    const dateStr = simDate.toISOString().replace("T", " ").substring(0, 16) + "Z";

    ctx.textAlign = "right";
    ctx.fillText(`VALID: ${dateStr}`, width - 20, 30);

    // 底部水印
    ctx.font = "900 32px 'Inter', sans-serif"; 
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("STORM_INC®", width - 20, height - 10);

    return canvas;
}