/**
 * terrain-data.js
 * 负责管理地形高程数据和陆地遮罩
 */

let elevationData = null; // 存储高程图像素数据 (RGBA)
let landMaskData = null;  // 存储陆地遮罩像素数据 (Alpha channel only is enough, but we use RGBA)
let mapWidth = 0;
let mapHeight = 0;

const MAX_ELEVATION_METERS = 680; // 设定最大海拔

// 初始化地形系统
export function initTerrainSystem(imageUrl, worldData) {
    return new Promise((resolve, reject) => {
        // 1. 加载高程图
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = imageUrl;
        
        img.onload = () => {
            mapWidth = img.width;
            mapHeight = img.height;
            
            // --- A. 处理高程数据 ---
            const elevCanvas = document.createElement('canvas');
            elevCanvas.width = mapWidth;
            elevCanvas.height = mapHeight;
            const elevCtx = elevCanvas.getContext('2d');
            elevCtx.drawImage(img, 0, 0);
            const rawData = elevCtx.getImageData(0, 0, mapWidth, mapHeight).data;
            elevationData = new Uint8Array(mapWidth * mapHeight);
            for (let i = 0, j = 0; i < rawData.length; i += 4, j++) {
                elevationData[j] = rawData[i]; // 只取 Red 通道
            }
            // --- B. 生成陆地遮罩 (Land Mask) ---
            // 使用 D3 将矢量地图绘制到内存 Canvas 上
            if (worldData) {
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = mapWidth;
                maskCanvas.height = mapHeight;
                const maskCtx = maskCanvas.getContext('2d');

                // 设置投影以匹配图片 (Equirectangular)
                const projection = d3.geoEquirectangular()
                    .scale(mapWidth / (2 * Math.PI))
                    .translate([mapWidth / 2, mapHeight / 2]);

                const pathGenerator = d3.geoPath()
                    .projection(projection)
                    .context(maskCtx);

                // 绘制背景（海洋 = 黑色）
                maskCtx.fillStyle = '#000000';
                maskCtx.fillRect(0, 0, mapWidth, mapHeight);

                // 绘制陆地（陆地 = 白色）
                maskCtx.fillStyle = '#FFFFFF';
                maskCtx.beginPath();
                pathGenerator(worldData);
                maskCtx.fill();

                // 获取遮罩数据
                const raw = maskCtx.getImageData(0, 0, mapWidth, mapHeight).data;
                landMaskData = new Uint8Array(mapWidth * mapHeight);

                for (let i = 0, j = 0; i < raw.length; i += 4, j++) {
                    landMaskData[j] = raw[i];
                }
            }

            console.log(`Terrain System Initialized. Size: ${mapWidth}x${mapHeight}`);
            resolve();
        };
        
        img.onerror = (e) => reject(e);
    });
}

// 内部辅助：经纬度转像素坐标
function getPixelCoords(lon, lat) {
    // 经度归一化 [-180, 180] -> [0, 360]
    let normLon = ((lon + 180) % 360 + 360) % 360 - 180;

    // 映射到像素
    // 假设图片是标准等距投影: -180在左边缘, +180在右边缘
    let x = Math.floor(((normLon + 180) / 360) * (mapWidth - 1));
    let y = Math.floor(((90 - lat) / 180) * (mapHeight - 1));

    // 边界钳制
    x = Math.max(0, Math.min(x, mapWidth - 1));
    y = Math.max(0, Math.min(y, mapHeight - 1));

    return { x, y };
}

// 获取海拔 (米)
export function getElevationAt(lon, lat) {
    if (!elevationData) return 0;
    const { x, y } = getPixelCoords(lon, lat);
    const index = y * mapWidth + x;
    const brightness = elevationData[index]; // Read Red channel
    
    // 如果亮度很低，直接返回0
    if (brightness < 5) return 0;
    return (brightness / 255) * MAX_ELEVATION_METERS;
}

// 获取陆地状态 (包含 isLand 和 isNearLand)
// nearThresholdDeg: 近岸判定阈值，单位度。默认 0.2 度
export function getLandStatus(lon, lat, nearThresholdDeg = 0.2) {
    if (!landMaskData) return { isLand: false, isNearLand: false };

    const { x: cx, y: cy } = getPixelCoords(lon, lat);
    
    // 1. 判断正中心是否为陆地 (R通道 > 128 即为白色)
    const idx = cy * mapWidth + cx;
    const isLand = landMaskData[idx] > 128;

    // 2. 判断 Near Land
    const pixelsPerDeg = mapWidth / 360;
    const radius = Math.max(1, Math.ceil(nearThresholdDeg * pixelsPerDeg));

    let isNearLand = isLand; // 如果已经在陆地上，当然也是 Near Land

    if (!isLand) {
        // 只有当中心在海上时，才去搜寻周围
        // 搜索 3x3 或 5x5 区域
        searchLoop:
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0) continue;

                let nx = cx + dx;
                let ny = cy + dy;

                // 处理地图水平循环
                if (nx < 0) nx += mapWidth;
                if (nx >= mapWidth) nx -= mapWidth;
                // 垂直方向不循环，直接夹断
                if (ny < 0 || ny >= mapHeight) continue;

                const idx = (ny * mapWidth + nx) * 4;
                if (landMaskData[idx] > 128) {
                    isNearLand = true;
                    break searchLoop; // 找到一个陆地像素即可停止
                }
            }
        }
    }

    return { isLand, isNearLand };
}