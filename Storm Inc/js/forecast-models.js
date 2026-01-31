/**
 * forecast-models.js
 * 负责生成各种数值模型的预报数据。
 * [修正版] 修复陆地检测逻辑，检测"预报点"而非"初始点"
 */
import { getSST, normalizeLongitude } from './utils.js';
import { calculateSteering, updatePressureSystems } from './cyclone-model.js';
import { calculateBackgroundHumidity } from './visualization.js';

// [辅助] 坐标清洗
function wrap180(lon) {
    lon = lon % 360;
    return (lon > 180) ? lon - 360 : (lon < -180 ? lon + 360 : lon);
}

export function generatePathForecasts(cyclone, pressureSystems, checkLandFunc = null, globalTemp = 289, globalShearSetting = 100) {
    if (cyclone.isExtratropical) {
        return [];
    }
    const forecasts = [];
    
    // 模型定义
    const models = [
        { name: "ENAI", bias: { u: 0.5, v: 0.6 } },
    ];

    // 参数配置
    const PATH_STEP_HOURS = 3;
    const INTENSITY_STEP_HOURS = 6;
    const TOTAL_HOURS = 72; // 预测时长
    
    const STEPS_PER_INTENSITY_UPDATE = INTENSITY_STEP_HOURS / PATH_STEP_HOURS; 
    const TOTAL_STEPS = TOTAL_HOURS / PATH_STEP_HOURS; 

    models.forEach(model => {
        let tempCyclone = JSON.parse(JSON.stringify(cyclone));
        let tempPressureSystems = JSON.parse(JSON.stringify(pressureSystems));
        
        let track = [[tempCyclone.lon, tempCyclone.lat, tempCyclone.intensity, tempCyclone.isTransitioning, tempCyclone.isExtratropical]];

        let lastCalculatedIntensity = tempCyclone.intensity;
        const startAge = tempCyclone.age || 0;
        for(let t = 1; t <= TOTAL_STEPS; t++) { 
            // 1. 路径计算 (3小时/步)
            updatePressureSystems(tempPressureSystems, cyclone.currentMonth);
            const { steerU, steerV, shearU, shearV } = calculateSteering(tempCyclone.lon, tempCyclone.lat, tempPressureSystems, model.bias);
            
            let steeringDirection = (Math.atan2(steerU, steerV) * 180 / Math.PI + 360) % 360;
            let angleDiff = steeringDirection - tempCyclone.direction;
            while (angleDiff < -180) angleDiff += 360;
            while (angleDiff > 180) angleDiff -= 360;
            tempCyclone.direction = (tempCyclone.direction + angleDiff * 0.25 + 360) % 360;
            
            const steeringSpeedKnots = Math.hypot(steerU, steerV) * 1.94384;
            tempCyclone.speed += (steeringSpeedKnots - tempCyclone.speed) * 0.3;
            
            const currentSpeed = Math.max(3, tempCyclone.speed);
            const angleRad = (90 - tempCyclone.direction) * (Math.PI / 180);
            const distanceDeg = currentSpeed * PATH_STEP_HOURS * 1.852 / 111;
            
            tempCyclone.lat += distanceDeg * Math.sin(angleRad);
            tempCyclone.lon = normalizeLongitude(tempCyclone.lon + (distanceDeg * Math.cos(angleRad)) / Math.cos(tempCyclone.lat * Math.PI / 180));

            // 2. 强度计算 (12小时/步)
            if (t % STEPS_PER_INTENSITY_UPDATE === 0) {
                const queryLon = wrap180(tempCyclone.lon);
                
                // [修正核心] 检测"当前预报点"是否在陆地，而不是检测 cyclone.isLand (初始点)
                const isForecastingLand = checkLandFunc(tempCyclone.lon, tempCyclone.lat);
                // 只有在非陆地时才查 SST，节省性能
                let sst = 29.0;
                let hum = 65.0;
                
                if (!isForecastingLand) {
                    const val = getSST(tempCyclone.lat, tempCyclone.lon, cyclone.currentMonth || 8, globalTemp);
                    if (val !== undefined && val !== null && val > -5) sst = val;
                    
                    // [关键修改] 安全调用：如果函数存在且运行正常，才覆盖默认值
                    if (typeof calculateBackgroundHumidity === 'function') {
                        try {
                            const hVal = calculateBackgroundHumidity(tempCyclone.lon, tempCyclone.lat, pressureSystems, cyclone.currentMonth, cyclone, globalTemp);
                            // 确保返回值是有效数字
                            if (typeof hVal === 'number' && !isNaN(hVal)) {
                                hum = hVal;
                            }
                        } catch (e) {
                            console.warn("Forecast humidity calc failed, using 65", e);
                            hum = 65.0;
                        }
                    }
                }

                let nextIntensity = lastCalculatedIntensity;

                if (isForecastingLand) {
                    // --- 陆地逻辑 (衰减) ---
                    const frictionDecay = Math.max(5, lastCalculatedIntensity * 0.22); 
                    let naturalDecayResult = lastCalculatedIntensity - frictionDecay;

                    // 强制约束：强度上限 = 上次强度 - 10KT
                    const hardCap = lastCalculatedIntensity - 10;
                    
                    nextIntensity = Math.min(naturalDecayResult, hardCap);
                } else {
                    // --- 海洋逻辑 (增强/维持) ---
                    let mpi = 0;
                    if (sst >= 24.7) {
                        // 考虑湿度影响的 MPI
                        mpi = (15 + (sst - 24.7) * 24.7 - (75 - hum)) * (1.08 - 1/tempCyclone.lat); 
                    }
                    const safeShearU = Number.isFinite(shearU) ? shearU : 0;
                    const safeShearV = Number.isFinite(shearV) ? shearV : 0;
                    const physicalShear = Math.hypot(safeShearU, safeShearV) * 2.5;
                    const totalShear = physicalShear * (globalShearSetting / 100.0);
                    const gap = mpi - lastCalculatedIntensity;
                    const changeRate = gap > 0 ? Math.random()*0.04 + 0.07 - 0.9/lastCalculatedIntensity - (totalShear * 0.005) : 0.11 + (totalShear * 0.003); 
                    nextIntensity += gap * changeRate;
                    const currentForecastAge = startAge + (t * PATH_STEP_HOURS);
                    
                    if (tempCyclone.shearEventActive && currentForecastAge < tempCyclone.shearEventEndTime) {
                        const shearPenalty = tempCyclone.shearEventMagnitude * (Math.random() + 0.5);
                        nextIntensity -= shearPenalty;
                    }
                }

                nextIntensity = Math.max(15, nextIntensity);
                tempCyclone.intensity = nextIntensity;
                lastCalculatedIntensity = nextIntensity;
            } 
            
            track.push([
                tempCyclone.lon, 
                tempCyclone.lat, 
                tempCyclone.intensity, 
                tempCyclone.isTransitioning || false, 
                tempCyclone.isExtratropical || false
            ]);
        }
        forecasts.push({ name: model.name, track: track });
    });
    return forecasts;
}