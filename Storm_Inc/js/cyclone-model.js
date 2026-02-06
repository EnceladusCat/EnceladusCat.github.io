/**
 * cyclone-model.js
 * Core logic
 */
import { NAME_LISTS, getSST, getPressureAt, normalizeLongitude, calculateDistance, windToPressure } from './utils.js';
import { getElevationAt, getLandStatus } from './terrain-data.js';
import { calculateBackgroundHumidity } from './visualization.js';

const basinConfig = {
    'WPAC': { lon: { min: 100, max: 180 }, lat: { min: 5, max: 25 } },  // 西北太平洋
    'EPAC': { lon: { min: 180, max: 260 }, lat: { min: 5, max: 20 } },  // 东北太平洋 (140W to 80W)
    'NATL': { lon: { min: 260, max: 350 }, lat: { min: 6, max: 32 } },  // 北大西洋 (75W to 10W)
    'NIO':  { lon: { min: 60,  max: 100 }, lat: { min: 5, max: 25 } },   // 北印度洋
    'SHEM':  { lon: { min: 140,  max: 200 }, lat: { min: -15, max: -5 } },   // 南太平洋
    'SIO':  { lon: { min: 30,  max: 140 }, lat: { min: -15, max: -5 } },
    'SATL':  { lon: { min: -50,  max: 15 }, lat: { min: -25, max: -10 } }
};

function calculateLayerWind(lon, lat, systems) {
    const dDeg = 0.5;
    const RE = 6371000;
    const latRad = lat * (Math.PI / 180);
    const f = 2 * 7.292115e-5 * Math.sin(latRad);
    
    const effectiveF = Math.abs(f) < 5e-5 ? (f >= 0 ? 5e-5 : -5e-5) : f; 

    const p_x_plus = getPressureAt(lon + dDeg, lat, systems, false);
    const p_x_minus = getPressureAt(lon - dDeg, lat, systems, false);
    const p_y_plus = getPressureAt(lon, lat + dDeg, systems, false);
    const p_y_minus = getPressureAt(lon, lat - dDeg, systems, false);

    const gradX = (p_x_plus - p_x_minus);
    const gradY = (p_y_plus - p_y_minus);

    const scale = 6.0;
    const u = -gradY * scale / effectiveF * 0.0001; 
    const v =  gradX * scale / effectiveF * 0.0001;
    return { u, v };
}

export function getWindVectorAt(lon, lat, month, cyclone, pressureSystems) {
    let k = 1.0;
    let alphaDeg = 15;
    const landInfo = getLandStatus(lon, lat);
    const isLand = landInfo ? landInfo.isLand : false;
    if (isLand) {
        const elevation = getElevationAt(lon, lat) || 0;
        k = Math.max(0.4, 0.8 - (elevation / 1700));
        alphaDeg = Math.min(55, 15 + (elevation / 17));
    }

    const inflowAngle = alphaDeg * (Math.PI / 180);

    // 1. Environmental Flow
    const envWind = calculateLayerWind(lon, lat, pressureSystems.lower);
    
    // 2. Vortex Flow
    let u_vortex = 0;
    let v_vortex = 0;
    let u_trans = 0;
    let v_trans = 0;

    if (cyclone.status === 'active') {
        const dist = calculateDistance(lat, lon, cyclone.lat, cyclone.lon);
        const RMW = 5 + cyclone.circulationSize * 0.125;
        const outerRadius = cyclone.circulationSize * 4.0; 

        if (dist < outerRadius) {
            let vortexSpeed = 0;
            const maxWind = cyclone.intensity;

            if (dist < RMW) {
                vortexSpeed = maxWind * (dist / RMW);
            } else {
                const decayExponent = 0.80 - cyclone.circulationSize * 0.0002;
                const rawSpeed = maxWind * Math.pow(RMW / dist, decayExponent);
                
                // Decay
                let fade = 1;
                const fadeStart = outerRadius * 0.35;
                if (dist > fadeStart) {
                    const t = (dist - fadeStart) / (outerRadius - fadeStart);
                    fade = (Math.exp(-2*t) - Math.exp(-2)) / (1 - Math.exp(-2));
                }
                vortexSpeed = rawSpeed * fade;
            }

            const dx = lon - cyclone.lon;
            const dy = lat - cyclone.lat;
            const angleToCenter = Math.atan2(dy, dx);
            
            // Inflow Angle
            const rotationOffset = (cyclone.lat >= 0) ? (Math.PI / 2 + inflowAngle) : (-Math.PI / 2 - inflowAngle);
            const windAngle = angleToCenter + rotationOffset;

            const speedMs = vortexSpeed; 

            u_vortex = Math.cos(windAngle) * speedMs;
            v_vortex = Math.sin(windAngle) * speedMs;
            const moveSpeed = cyclone.speed;
            const moveAngleMath = (450 - cyclone.direction) % 360 * (Math.PI / 180);
            const asymmetryFactor = 0.6;
            u_trans = Math.cos(moveAngleMath) * moveSpeed * asymmetryFactor;
            v_trans = Math.sin(moveAngleMath) * moveSpeed * asymmetryFactor;
            let transDecay = 1.0;
            if (dist > RMW) {
                transDecay = Math.max(0, 1 - (dist - RMW) / (outerRadius - RMW));
            }
            
            u_trans *= transDecay;
            v_trans *= transDecay;
        }
    }

    return { 
        u: envWind.u + u_vortex * k + u_trans, 
        v: envWind.v + v_vortex * k + v_trans, 
        magnitude: Math.hypot(envWind.u + u_vortex * k + u_trans, envWind.v + v_vortex * k + v_trans) 
    };
}

export function initializeCyclone(world, month, basin = 'WPAC', globalTemp, globalShear, customLon = null, customLat = null) {
    let lat, lon, isOverLand;

    let useCustomCoords = (customLon !== null && customLat !== null);
    
    if (useCustomCoords) {
        isOverLand = world.features.some(feature => d3.geoContains(feature, [customLon, customLat]));
        if (isOverLand) {
            console.warn(`Custom coordinates (${customLon}, ${customLat}) are on land. Falling back to random generation.`);
            useCustomCoords = false;
        } else {
            lon = customLon;
            lat = customLat;
            // console.log(`Using custom generation point: ${lon}, ${lat}`);
        }
    }
    
    if (!useCustomCoords) {
        const selectedBasin = basinConfig[basin] || basinConfig['WPAC']; // WPAC default
        const lonRange = selectedBasin.lon;
        const latBaseRange = selectedBasin.lat;

        const seasonalFactor = (Math.cos((month - 8) * (Math.PI / 6)) + 1) / 2; // 0 ~ 1

        const latRangeSpan = latBaseRange.max - latBaseRange.min;
        const hem = latBaseRange.max > 0 ? 1 : -1;
        const seasonalShift = latBaseRange.max > 0 ? (latRangeSpan / 4) * (seasonalFactor - 0.5) :
        (latRangeSpan / 4) * (seasonalFactor - 0.5);
        const currentMinLat = latBaseRange.min + seasonalShift + hem*Math.max(0,(globalTemp / 2.89 - 100));
        const currentMaxLat = latBaseRange.max + 4 * seasonalShift + hem*(globalTemp / 2.89 - 100);
        const latSpan = currentMaxLat - currentMinLat;

        // 4. Don't spawn on land
        let sst;
        do {
            lat = currentMinLat + Math.random() * latSpan;
            lon = lonRange.min + Math.random() * (lonRange.max - lonRange.min);
            const status = getLandStatus(lon, lat);
            isOverLand = status.isLand;

            sst = getSST(lat, lon, month, globalTemp);

        } while (isOverLand || sst < 25.4); // 如果在陆地上或者海温过低，重试
    }

    // --- Subtropical ---
    const initialSST = getSST(lat, lon, month, globalTemp);
    let isSubtropical = false;
    let subtropicalTransitionTime = 0;
    if (initialSST < 27.5 && Math.random() < 0.75 && (lon > 122 || lon < 40)) {
        isSubtropical = true;
        const durationSteps = 0 + Math.floor(Math.random() * 25);
        subtropicalTransitionTime = durationSteps * 3;
    }

    let isMonsoonDepression = false;
    let monsoonDepressionEndTime = 0;
    if (Math.random() < (0.2 + globalTemp / 72.25 - 4) && (lat > 0)) {
        isMonsoonDepression = true;
        const durationSteps = Math.floor(Math.random() * 50);
        monsoonDepressionEndTime = durationSteps * 3;
    }

    return {
        lat: lat,
        lon: lon,
        intensity: 23 + Math.random() * 2,
        direction: Math.random() * 360,
        speed: 10 + Math.random() * 5,
        basin: basin,
        age: 0,
        shearEventActive: false,
        shearEventEndTime: 0,
        shearEventMagnitude: 0,
        track: [],
        status: 'active',
        isTransitioning: false,
        isLand: isOverLand || false,
        isExtratropical: false,
        isSubtropical: isSubtropical,
        subtropicalTransitionTime: subtropicalTransitionTime,
        isMonsoonDepression: isMonsoonDepression,
        monsoonDepressionEndTime: monsoonDepressionEndTime,
        extratropicalStage: 'none',
        extratropicalDevelopmentEndTime: 0,
        extratropicalMaxIntensity: 0,
        upwellingCoolingEffect: 0,
        isERCActive: false,
        ercState: 'none',
        ercEndTime: 0,
        ercMpiReduction: 0,
        ercSizeFactor: 1.0,
        circulationSize: 150 + Math.random() * 350,
        r34: 0, r50: 0, r64: 0,
        forecastLogs: {},
        ace: 0
    };

}

export function initializePressureSystems(cyclone, month) {
    if (typeof month !== 'number' || !Number.isFinite(month)) month = 8;
    
    const tempAllSystems = [];
    
    const seasonalFactor = (Math.cos((month - 8) * (Math.PI / 6)) + 1) / 2;
    const baseLat = cyclone.lat; 
    const baseLon = cyclone.lon; 

    // 1. Tropical Low
    tempAllSystems.push({
        type: 'high',
        x: 140, y: 1 + (Math.random() - 0.5) * 5, 
        baseSigmaX: 300, sigmaX: 300, sigmaY: 10 + Math.random() * 4, 
        strength: -(10 + Math.random() * 3), baseStrength: -(10 + Math.random() * 3),
        velocityX: (Math.random() - 0.5) * 0.1, velocityY: (Math.random() - 0.5) * 0.1,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.01 + Math.random() * 0.01, oscillationAmount: 0.1,
        noiseLayers: []
    });

    tempAllSystems.push({
        type: 'low',
        x: 120, y: 10 + (Math.random() - 0.5) * 5, 
        baseSigmaX: 70, sigmaX: 70, sigmaY: 20 + Math.random() * 4, 
        strength: -(5 + Math.random() * 3) * (0.5+0.5*seasonalFactor), baseStrength: -(5 + Math.random() * 3) * (0.5+0.5*seasonalFactor),
        velocityX: (Math.random() - 0.5) * 0.01, velocityY: (Math.random() - 0.5) * 0.01,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.01 + Math.random() * 0.01, oscillationAmount: 0.01,
        noiseLayers: []
    });

    // 2. Subtropical High
    // (A) WPAC
    tempAllSystems.push({
        type: 'high',
        x: 150 + (Math.random() - 0.5) * 50, 
        y: 26 + (Math.random() - 0.5) * 8 + 14 * seasonalFactor,
        baseSigmaX: 25 + Math.random() * 30, sigmaX: 0, sigmaY: 10 + Math.random() * 15,
        strength: 15 + Math.random() * 6, baseStrength: 15 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.9, velocityY: (Math.random() - 0.5) * 0.3,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.02 + Math.random() * 0.01, oscillationAmount: 0.2 + Math.random() * 0.5,
        noiseLayers: []
    });
    // (B) WPAC Land
    tempAllSystems.push({
        type: 'high',
        x: 115 + (Math.random() - 0.5) * 50, 
        y: 23 + (Math.random() - 0.5) * 10 + 14 * seasonalFactor,
        baseSigmaX: 30 + Math.random() * 25, sigmaX: 0, sigmaY: 5 + Math.random() * 25,
        strength: 8 + Math.random() * 11, baseStrength: 8 + Math.random() * 11,
        velocityX: (Math.random() - 0.5) * 1.5, velocityY: (Math.random() - 0.5) * 1.6,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.05, oscillationAmount: 0.25 + Math.random() * 0.3,
        noiseLayers: []
    });
    // (B2) WPAC Land 2
    tempAllSystems.push({
        type: 'high',
        x: 50 + (Math.random() - 0.5) * 15, 
        y: 24 + (Math.random() - 0.5) * 10 + 12 * seasonalFactor,
        baseSigmaX: 30 + Math.random() * 10, sigmaX: 0, sigmaY: 10 + Math.random() * 8,
        strength: 10 + Math.random() * 8, baseStrength: 10 + Math.random() * 8,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });
    // (C) Hawaii High
    tempAllSystems.push({
        type: 'high',
        x: -140 + (Math.random() - 0.5) * 40, 
        y: 20 + (Math.random() - 0.5) * 20 + 6 * seasonalFactor,
        baseSigmaX: 40 + Math.random() * 25, sigmaX: 0, sigmaY: 13 + Math.random() * 13,
        strength: 20 + Math.random() * 12, baseStrength: 20 + Math.random() * 12,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.005 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });
    // (D) Atlantic High
    tempAllSystems.push({
        type: 'high',
        x: -30 + (Math.random() - 0.5) * 15, 
        y: 30 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor,
        baseSigmaX: 50 + Math.random() * 10, sigmaX: 0, sigmaY: 10 + Math.random() * 10,
        strength: 22 + Math.random() * 6, baseStrength: 22 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });
    // South Hemisphere Highs
    tempAllSystems.push({
        type: 'high', x: 75 + (Math.random() - 0.5) * 50, y: -22 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor,
        baseSigmaX: 40 + Math.random() * 60, sigmaX: 0, sigmaY: 5 + Math.random() * 10,
        strength: 20 + Math.random() * 6, baseStrength: 20 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });
    tempAllSystems.push({
        type: 'high', x: 150 + (Math.random() - 0.5) * 50, y: -22 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor,
        baseSigmaX: 15 + Math.random() * 35, sigmaX: 0, sigmaY: 5 + Math.random() * 10,
        strength: 18 + Math.random() * 6, baseStrength: 18 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });
    tempAllSystems.push({
        type: 'high', x: -30 + (Math.random() - 0.5) * 50, y: -22 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor,
        baseSigmaX: 15 + Math.random() * 20, sigmaX: 0, sigmaY: 5 + Math.random() * 10,
        strength: 15 + Math.random() * 6, baseStrength: 15 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });

    // (E) Polar Low
    tempAllSystems.push({
        type: 'high',
        x: -60 + (Math.random() - 0.5) * 15, 
        y: 72 + (Math.random() - 0.5) * 10,
        baseSigmaX: 250, sigmaX: 250, sigmaY: 10 + Math.random() * 5,
        strength: 25 + Math.random() * 6, baseStrength: 25 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.025 + Math.random() * 0.01, oscillationAmount: 0.25 + Math.random() * 0.2,
        noiseLayers: []
    });

    // (U) Local Low
    tempAllSystems.push({
        type: 'high',
        x: 100 + (Math.random() - 0.5) * 5, y: 20 + (Math.random() - 0.5) * 5,
        sigmaX: 5, sigmaY: 3 + Math.random() * 2,
        strength: 6 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5, velocityY: (Math.random() - 0.5) * 0.4,
        noiseLayers: []
    });

    // (F1) Random Low
    const numberOfSystems = 2 + Math.floor(Math.random() * 11);
    for (let i = 0; i < numberOfSystems; i++) {
        tempAllSystems.push({
            type: 'low',
            x: (Math.random() - 0.5) * 60 + baseLon,
            y: baseLat > 0 ? Math.max(10, (Math.random() - 0.2) * 25 + baseLat) : Math.min(-10, (Math.random() - 0.7) * 20 + baseLat),
            sigmaX: 1 + Math.random() * 3, sigmaY: 1 + Math.random() * 4,
            strength: -4 + (Math.random()) * 2,
            velocityX: 0.5 - Math.random() * 1, velocityY: (Math.random() - 0.5) * 0.1,
            noiseLayers: [ { offsetX: 0, offsetY: 0, freqX: 5, freqY: 5, amplitude: 0.1 }, { offsetX: 0, offsetY: 0, freqX: 1, freqY: 1, amplitude: Math.random() * 0.1 } ]
        });
    }

    // (F0) Random High
    const numberOfSystemsH = 0 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numberOfSystemsH; i++) {
        tempAllSystems.push({
            type: 'high',
            x: (Math.random() - 0.5) * 60 + baseLon,
            y: baseLat > 0 ? Math.max(15, (Math.random() - 1) * 5 + baseLat) : Math.min(-15, (Math.random() + 1) * 5 + baseLat),
            sigmaX: 2 + Math.random() * 4, sigmaY: 2 + Math.random() * 1,
            strength: 1 + (Math.random()) * 10,
            velocityX: 0.5 - Math.random() * 1, velocityY: (Math.random() - 0.5) * 0.1,
            noiseLayers: []
        });
    }

    // (F2) Random System
    const isWinterSeason = (month >= 10 || month <= 3);

    if (!isWinterSeason && Math.random() < 0.95) {
        tempAllSystems.push({
            type: 'low',
            x: 85  + (Math.random() - 0.5) * 15, y: 25  + (Math.random() - 0.5) * 5,
            sigmaX: 30 + Math.random() * 3, sigmaY: 10, strength: -10 - (Math.random()) * 5,
            velocityX: (Math.random()-0.5) * 0.2, velocityY: Math.random() * -1.0, noiseLayers: []
        });
    }

    // 3. Subtropical Low(North)
    const subtropicalHighs = tempAllSystems.filter(p => p.strength > 0 && p.y > 10 && p.y < 45);
    const meanSubtropicalLat = subtropicalHighs.length > 0 ? subtropicalHighs.reduce((sum, p) => sum + p.y, 0) / subtropicalHighs.length : 45;
    const subpolarLat = meanSubtropicalLat + 18 + (Math.random() - 0.5) * 4;

    tempAllSystems.push({
        type: 'high',
        x: 150, y: subpolarLat, baseSigmaX: 250, sigmaX: 250, sigmaY: 8 + Math.random() * 5,
        strength: -(65 + Math.random() * 10), baseStrength: -(65 + Math.random() * 10),
        velocityX: (Math.random() - 0.5) * 0.2, velocityY: (Math.random() - 0.5) * 0.1,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.015 + Math.random() * 0.01, oscillationAmount: 0.15,
        noiseLayers: []
    });

    // 4. Subtropical Low(South)
    const subtropicalHighsS = tempAllSystems.filter(p => p.strength > 0 && p.y < -10 && p.y > -40);
    const meanSubtropicalLatS = subtropicalHighsS.length > 0 ? subtropicalHighsS.reduce((sum, p) => sum + p.y, 0) / subtropicalHighsS.length : -40;
    const subpolarLatS = meanSubtropicalLatS - 18 - (Math.random() - 0.5) * 4;

    tempAllSystems.push({
        type: 'high',
        x: 150, y: -35 - Math.random() * 5, baseSigmaX: 250, sigmaX: 250, sigmaY: 5 + Math.random() * 5,
        strength: -(40 + Math.random() * 10), baseStrength: -(40 + Math.random() * 10),
        velocityX: (Math.random() - 0.5) * 0.2, velocityY: (Math.random() - 0.5) * 0.1,
        oscillationPhase: Math.random() * Math.PI * 2, oscillationSpeed: 0.015 + Math.random() * 0.01, oscillationAmount: 0.15,
        noiseLayers: []
    });

    // --- 2. Double Layer ---
    
    const upperSystems = [];
    const lowerSystems = [];

    tempAllSystems.forEach(sys => {
        const upperSys = JSON.parse(JSON.stringify(sys));
        const lowerSys = JSON.parse(JSON.stringify(sys));
        const absLat = Math.abs(sys.y);
        if (sys.type === 'high') {
            upperSys.strength *= 0.6;
            lowerSys.strength *= 0.4;
        } else {
            upperSys.strength *= 0.4; 
            lowerSys.strength *= 0.5;
        }

        // Random tilt
        upperSys.x += (Math.random() - 0.5) * 2;
        lowerSys.x += (Math.random() - 0.5) * 2;

        upperSystems.push(upperSys);
        lowerSystems.push(lowerSys);
    });

    const systemsObj = { upper: upperSystems, lower: lowerSystems };
    updatePressureSystems(systemsObj);
    return systemsObj;
}

export function updatePressureSystems(systemsObj, month) {
    const updateList = (list) => {
        for (let i = list.length - 1; i >= 0; i--) {
            const cell = list[i];
            
            cell.x += cell.velocityX;
            cell.y += cell.velocityY;
            
            // Cold Surge ---
            if (cell.isColdSurge) {
                // 1. Fade
                if (cell.y < 30) {
                    const decay = Math.max(0, (cell.y - 10) / 20);
                    cell.strength *= 0.96 * decay;
                    
                    if (cell.sigmaX) cell.sigmaX *= 1.02; 
                    if (cell.sigmaY) cell.sigmaY *= 0.98;
                }

                // 2. Delete
                if (cell.strength < 1.5 || cell.y < 5) {
                    list.splice(i, 1);
                    continue;
                }
            } else {
                if (cell.x > 360) cell.x -= 360;
                if (cell.x < 0) cell.x += 360;
            }

            if (cell.oscillationSpeed) {
                cell.oscillationPhase = (cell.oscillationPhase || 0) + cell.oscillationSpeed;
                const stretch = Math.sin(cell.oscillationPhase) * cell.oscillationAmount;
                if (cell.baseSigmaX) {
                    cell.sigmaX = cell.baseSigmaX * (1 + stretch);
                }
            }
        }
    };

    if (systemsObj.upper) updateList(systemsObj.upper);
    
    if (systemsObj.lower) {
        updateList(systemsObj.lower);
        
        // --- Generation ---
        const isWinter = (month >= 10 || month <= 3);
        
        const activeSurges = systemsObj.lower.filter(s => s.isColdSurge).length;

        if (isWinter && activeSurges < 1 && Math.random() < 0.1) {
            console.log("cold high.");
            systemsObj.lower.push({
                type: 'high',
                isColdSurge: true, // 标记为冷涌
                
                x: 100 + Math.random() * 15, 
                y: 42 + Math.random() * 5,
                
                baseSigmaX: 6, sigmaX: 6, 
                sigmaY: 8 + Math.random() * 5,
                
                strength: 30 + Math.random() * 15,
                
                velocityX: 0.15 + Math.random() * 0.1,
                velocityY: -0.2 - Math.random() * 0.2, 
                
                oscillationSpeed: 0,
                noiseLayers: []
            });
        }
    }
    
    return systemsObj;
}

export function updateFrontalZone(pressureSystemsObj, month) {
    const list = Array.isArray(pressureSystemsObj) ? pressureSystemsObj : pressureSystemsObj.upper;
    
    const highs = list.filter(p => p.strength > 8 && p.y > 10);
    if (highs.length === 0) return { latitude: 35 };
    
    const avgLat = highs.reduce((sum, p) => sum + p.y, 0) / highs.length;
    return { latitude: avgLat + 8 * Math.cos((month - 8) * (Math.PI / 6)) + 3 * Math.random() - 11 };
}

export function calculateSteering(lon, lat, pressureSystemsObj, bias = { u: 0, v: 0 }) {
    const windUpper = calculateLayerWind(lon, lat, pressureSystemsObj.upper);
    const windLower = calculateLayerWind(lon, lat, pressureSystemsObj.lower);

    // 3. Deep Layer Mean
    const weightUpper = 0.8;
    const weightLower = 0.2;

    const steerU = 0.7*(windUpper.u * weightUpper + windLower.u * weightLower) + bias.u;
    const steerV = 0.7*(windUpper.v * weightUpper + windLower.v * weightLower) + bias.v;

    // Beta Drift
    const latRad = lat * (Math.PI / 180);
    const betaFactor = Math.sin(latRad < 0 ? 1.2*latRad - (Math.PI/12) : 1.2*latRad + (Math.PI/12));
    const betaU = -0.6 * betaFactor; 
    const betaV = 4.4 * betaFactor;

    // Shear Vector
    const shearU = windUpper.u - windLower.u;
    const shearV = windUpper.v - windLower.v;

    return { 
        steerU: steerU + betaU, 
        steerV: steerV + betaV,
        shearU,
        shearV
    };
}

export function updateCycloneState(cyclone, pressureSystems, frontalZone, world, month, globalTemp, globalShearSetting, nameIndex) {
    let updatedCyclone = { ...cyclone };
    updatedCyclone.age += 3;

    // --- ACE Calculation ---
    if (updatedCyclone.age % 6 === 0 && updatedCyclone.intensity >= 34 && !updatedCyclone.isExtratropical) {
        const ace_contribution = (updatedCyclone.intensity ** 2) / 10000;
        updatedCyclone.ace += ace_contribution;
    }

    if (updatedCyclone.isMonsoonDepression && updatedCyclone.age >= updatedCyclone.monsoonDepressionEndTime) {
        updatedCyclone.isMonsoonDepression = false;
    }

    // --- Steering ---
    const { steerU, steerV, shearU, shearV } = calculateSteering(updatedCyclone.lon, updatedCyclone.lat, pressureSystems);
    const physicalShear = Math.hypot(shearU, shearV) * 2.0; 
    
    // Wind Shear
    let totalShear = physicalShear * (globalShearSetting / 100.0);
    const isWinterHalf = (month >= 11 || month <= 4);
    const shearEventProb = (isWinterHalf && updatedCyclone.lon > 100 && updatedCyclone.lon < 121 && updatedCyclone.lat > 16) ? 0.55 : (isWinterHalf ? 0.045 * (globalShearSetting ** 2 / 10000) : 0.03 * (globalShearSetting ** 2 / 10000));
    // Random shear event
    if (updatedCyclone.shearEventActive) {
        if (updatedCyclone.age >= updatedCyclone.shearEventEndTime) {
            updatedCyclone.shearEventActive = false;
            updatedCyclone.shearEventMagnitude = 0;
        } else {
            totalShear += Math.max(0, updatedCyclone.shearEventMagnitude);
        }
    } else if (Math.random() < shearEventProb && !updatedCyclone.isTransitioning) {
        updatedCyclone.shearEventActive = true;
        updatedCyclone.shearEventEndTime = updatedCyclone.age + (1 + Math.random()*48);
        updatedCyclone.shearEventMagnitude = -3 + Math.random() * 6 + 1.8 * Math.abs(month - 8) ** 0.5 + Math.max(0,(globalShearSetting / 10 - 10));
    }

    // Movement
    let steeringDirection = (Math.atan2(steerU, steerV) * 180 / Math.PI + 360) % 360;
    let angleDiff = steeringDirection - updatedCyclone.direction;
    while (angleDiff < -180) angleDiff += 360;
    while (angleDiff > 180) angleDiff -= 360;
    updatedCyclone.direction = (updatedCyclone.direction + angleDiff * 0.25 + 360) % 360;

    const steeringSpeedKnots = Math.hypot(steerU, steerV) * 1.94384; 
    updatedCyclone.speed += (steeringSpeedKnots - updatedCyclone.speed) * (0.3 + Math.max(0, updatedCyclone.lat / 100));

    // Cold welling
    if (updatedCyclone.speed < 6) {
        const coolingRate = (6 - updatedCyclone.speed) / 6 * 0.25; 
        updatedCyclone.upwellingCoolingEffect = Math.min(updatedCyclone.upwellingCoolingEffect + coolingRate, 5.0); 
    } else {
        updatedCyclone.upwellingCoolingEffect = Math.max(updatedCyclone.upwellingCoolingEffect - 0.2, 0); 
    }

    let sst = getSST(updatedCyclone.lat, updatedCyclone.lon, month, globalTemp);
    sst -= updatedCyclone.upwellingCoolingEffect;
    
    // Transition
    if (!updatedCyclone.isTransitioning && sst < -8.0) {
        updatedCyclone.isTransitioning = true;
    }
    
    const oldIntensity = updatedCyclone.intensity;
    const terrainElevation = getElevationAt(updatedCyclone.lon, updatedCyclone.lat);
    const landStatus = getLandStatus(updatedCyclone.lon, updatedCyclone.lat, 0.2);
    const isOverLand = landStatus.isLand;
    const isNearLand = landStatus.isNearLand;

    updatedCyclone.isLand = isOverLand;
    const EXf = !updatedCyclone.isExtratropical ? 1 : 0.1;

    // --- Intensity Change (Strictly Preserved Coefficients) ---
    
    // 1. Terrain Decay
    if (terrainElevation > 0 && updatedCyclone.intensity > 45) {
        let weakeningFactor = 0.88 + updatedCyclone.circulationSize*0.0001*EXf - (terrainElevation / 1200);
        const JPAdj = (updatedCyclone.lat >= 30 && updatedCyclone.lat <= 40 && updatedCyclone.lon >= 129 && updatedCyclone.lon <= 140) ? 0.03 : 0;
        updatedCyclone.intensity *= weakeningFactor + JPAdj;
        updatedCyclone.circulationSize *= 1 + terrainElevation * 0.0008;

    } else if (isOverLand || isNearLand) {
        const JPAdjustment = (updatedCyclone.lat >= 30 && updatedCyclone.lat <= 40 && updatedCyclone.lon >= 129 && updatedCyclone.lon <= 140) ? 0.04 : 0;
        const PHAdjustment = (updatedCyclone.lat >= 5 && updatedCyclone.lat <= 18 && updatedCyclone.lon >= 120 && updatedCyclone.lon <= 127 && updatedCyclone.intensity < 85) ? 0.05 : 0;
        const AUAdjustment = (updatedCyclone.lat >= -18 && updatedCyclone.lat <= -10 && updatedCyclone.lon >= 123 && updatedCyclone.lon <= 137) ? 0.05 : 0;
        updatedCyclone.intensity *= 0.88 + updatedCyclone.circulationSize*0.0001*EXf + JPAdjustment + PHAdjustment + AUAdjustment;
        updatedCyclone.speed *= 0.99;

    } else if (updatedCyclone.isExtratropical) {
        updatedCyclone.speed += 1.5; 
        if (updatedCyclone.extratropicalStage === 'developing') {
            if (updatedCyclone.age >= updatedCyclone.extratropicalDevelopmentEndTime) {
                updatedCyclone.extratropicalStage = 'decaying';
                const decayRate = -6 + Math.random() * 6; 
                updatedCyclone.intensity += decayRate;
            } else {
                const divisor = 9 + Math.random() * 5; 
                const intensification = (updatedCyclone.extratropicalMaxIntensity - updatedCyclone.intensity) / divisor;
                updatedCyclone.intensity += intensification;
            }
        } else { 
            const decayRate = -1 - Math.random() * 2; 
            updatedCyclone.intensity += decayRate;
        }

    } else {
        // MPI Logic
        let mpi = sst > 25.0 ? 264.28 * (1 - Math.exp(-0.182 * (sst - 25.00))) : 0; // [保留]
        
        // ERC Logic
        switch (updatedCyclone.ercState) {
            case 'weakening':
                if (updatedCyclone.age < updatedCyclone.ercEndTime) {
                    updatedCyclone.ercMpiReduction = Math.random() * 7 * Math.max(0,(updatedCyclone.intensity / 90)); 
                    updatedCyclone.intensity -= updatedCyclone.ercMpiReduction;
                }
                updatedCyclone.circulationSize *= 1.015; 
                if (updatedCyclone.age >= updatedCyclone.ercEndTime) {
                    updatedCyclone.ercState = 'recovering';
                    const recoveryDuration = 2 + Math.floor(Math.random() * 8);
                    updatedCyclone.ercEndTime = updatedCyclone.age + recoveryDuration * 3;
                }
                break;
            case 'recovering':
                updatedCyclone.circulationSize *= 0.995;
                if (updatedCyclone.age >= updatedCyclone.ercEndTime) {
                    updatedCyclone.ercState = 'none';
                    updatedCyclone.ercMpiReduction = 0;
                }
                break;
            default:
                if (updatedCyclone.intensity > 96 && !isOverLand && !updatedCyclone.isTransitioning && Math.random() < 0.12) {
                    updatedCyclone.ercState = 'weakening';
                    const weakeningDuration = 4 + Math.floor(Math.random() * 10);
                    updatedCyclone.ercEndTime = updatedCyclone.age + weakeningDuration * 3;
                }
                break;
        }

        // Growth Rate Logic
        let latF = (0.4 / Math.abs(updatedCyclone.lat) ** 2) * (updatedCyclone.intensity / 50);
        let ri = Math.random() > 0.97 ? Math.random() * 0.35 - 0.05 : 0;
        let intensificationRate = Math.random() * (0.14 + ri) * Math.min(1, ((updatedCyclone.intensity - 13) / 65)) - latF; // [保留]

        if (updatedCyclone.isMonsoonDepression) {
            intensificationRate *= (Math.random() + 0.10) * 0.70; 
        }
        
        const potentialChange = (mpi - updatedCyclone.intensity) * intensificationRate;
        
        // Shear Factors
        let shear = totalShear / 10.0; 
        
        // Fix term
        const nioShearBoost = (updatedCyclone.lat >= 5 && updatedCyclone.lat <= 30 && updatedCyclone.lon >= 30 && updatedCyclone.lon <= 100) ? 8.5 : 0;
        const shemShearBoost = (updatedCyclone.lat <= -5 && updatedCyclone.lat >= -30 && updatedCyclone.lon >= 100) ? (25.0 * Math.sin((month - 2) * (Math.PI / 6))) : 0;
        
        let baseGradient = updatedCyclone.lat > 0 ? (0.0 + 2.0 * Math.cos((month - 2) * (Math.PI / 6))) : (0.0 + 1.5 * Math.sin((month - 2) * (Math.PI / 6)));
        let highLatCorrection = 0;
        if (Math.abs(updatedCyclone.lat) > 35) {
            highLatCorrection = Math.pow(Math.abs(updatedCyclone.lat) - 35, 0.9) * -0.1;
        }
        const latGradientFactor = baseGradient + highLatCorrection;

        shear += Math.max(0, (Math.abs(updatedCyclone.lat) * latGradientFactor - 30 + nioShearBoost + shemShearBoost)) / 20;

        // Dry Air Logic
        const samplingRadiusDeg = cyclone.circulationSize * 0.005;
        let envHumiditySum = 0;
        let minEnvHumidity = 60;
        const samplePoints = 12; 
        for (let i = 0; i < samplePoints; i++) {
            const angleRad = (i / samplePoints) * 2 * Math.PI;
            const sampleLon = cyclone.lon + samplingRadiusDeg * Math.cos(angleRad) / Math.cos(cyclone.lat * Math.PI / 180);
            const sampleLat = cyclone.lat + samplingRadiusDeg * Math.sin(angleRad);
            const val = calculateBackgroundHumidity(sampleLon, sampleLat, pressureSystems, month, cyclone, globalTemp);
            envHumiditySum += val;
            if (val < minEnvHumidity) minEnvHumidity = val;
        }
        const avgEnvHumidity = envHumiditySum / samplePoints;
        const effectiveHumidity = (minEnvHumidity * 0.4) + (avgEnvHumidity * 0.6);
        let dryAirFactor = 0;
        if (effectiveHumidity < 60) {
            const sizeSensitivity = 600 - cyclone.circulationSize; 
            dryAirFactor = (60 - effectiveHumidity) * 0.0002 * sizeSensitivity;
        }
        const currentSize = updatedCyclone.circulationSize || 300;
        const clampedSize = Math.max(150, Math.min(500, currentSize));
        const sizeFactor = 1.2 + (clampedSize - 150) * (0.8 - 1.2) / (500 - 150);
        updatedCyclone.intensity += (potentialChange - sizeFactor * shear - dryAirFactor);
    }

    // Extratropical Transition Trigger
    if ((!updatedCyclone.isExtratropical && sst < 25.5 && (Math.abs(updatedCyclone.lat) > frontalZone.latitude) || sst < 23.0) || (updatedCyclone.isSubtropical && sst < 25.5)) {
        updatedCyclone.isExtratropical = true;
        if (updatedCyclone.extratropicalStage === 'none') { 
            if (Math.random() < 0.33 && Math.abs(updatedCyclone.lat) > 25) { 
                updatedCyclone.extratropicalStage = 'developing';
                const developmentDurationSteps = 4 + Math.floor(Math.random() * 25);
                updatedCyclone.extratropicalDevelopmentEndTime = updatedCyclone.age + (developmentDurationSteps * 3);
                updatedCyclone.extratropicalMaxIntensity = 45 + Math.random() * 45;
            } else {
                updatedCyclone.extratropicalStage = 'decaying';
            }
        }
    }

    if (updatedCyclone.isSubtropical && (updatedCyclone.age >= updatedCyclone.subtropicalTransitionTime || updatedCyclone.isExtratropical)) {
        updatedCyclone.isSubtropical = false;
    }

    const intensityChange = updatedCyclone.intensity - oldIntensity;
    if (updatedCyclone.isExtratropical || updatedCyclone.isTransitioning) {
        updatedCyclone.circulationSize *= 1.04;
    } else if (intensityChange > 0.5) {
        updatedCyclone.circulationSize *= 0.99;
    } else {
        updatedCyclone.circulationSize *= 1.002;
    }
    updatedCyclone.circulationSize = Math.max(100, Math.min(updatedCyclone.circulationSize, 800));
    updatedCyclone.intensity = Math.max(10, updatedCyclone.intensity);
    
    const currentSpeed = Math.max(2, updatedCyclone.speed);
    const finalStepDirection = updatedCyclone.direction + (Math.random() - 0.5) * 30;
    const angleRad = (90 - finalStepDirection) * (Math.PI / 180);
    const distanceDeg = currentSpeed * 3 * 1.852 / 111;

    const currentEnvPressure = getPressureAt(updatedCyclone.lon, updatedCyclone.lat, pressureSystems);
    const currentCentralPressure = windToPressure(
        updatedCyclone.intensity, 
        updatedCyclone.circulationSize, 
        updatedCyclone.basin, 
        currentEnvPressure
    );

    // --- Wind Radii Calculation (Preserved) ---
    const RMW_KM = 5 + updatedCyclone.circulationSize * 0.15; 
    const MAX_SEARCH_KM = 900; 
    const STEP_KM = 15;        
    const SCAN_ANGLE_STEP = 10; 

    const getPointAt = (centerLon, centerLat, angleRad, distKm) => {
        const distDeg = distKm / 111.32; 
        const lonScale = 1.0 / Math.max(0.1, Math.cos(centerLat * Math.PI / 180));
        const lon = centerLon + distDeg * Math.cos(angleRad) * lonScale;
        const lat = centerLat + distDeg * Math.sin(angleRad);
        return [lon, lat];
    };

    const measureRadius = (angleRad, threshold) => {
        const [startLon, startLat] = getPointAt(updatedCyclone.lon, updatedCyclone.lat, angleRad, RMW_KM);
        const startVec = getWindVectorAt(startLon, startLat, month, updatedCyclone, pressureSystems);
        if (startVec.magnitude < threshold) return 0;

        let currentDist = RMW_KM;
        while (currentDist < MAX_SEARCH_KM) {
            const nextDist = currentDist + STEP_KM;
            const [lon, lat] = getPointAt(updatedCyclone.lon, updatedCyclone.lat, angleRad, nextDist);
            const vec = getWindVectorAt(lon, lat, month, updatedCyclone, pressureSystems);
            if (vec.magnitude < threshold) return currentDist;
            currentDist = nextDist;
        }
        return currentDist; 
    };

    const getQuadrantMax = (threshold) => {
        if (updatedCyclone.intensity < threshold) return [0, 0, 0, 0];
        const ranges = [ { start: 0, end: 90 }, { start: 270, end: 360 }, { start: 180, end: 270 }, { start: 90, end: 180 } ];
        const result = [];
        for (let range of ranges) {
            let maxKm = 0;
            for (let angle = range.start; angle <= range.end; angle += SCAN_ANGLE_STEP) {
                const rad = angle * (Math.PI / 180);
                const distKm = measureRadius(rad, threshold);
                if (distKm > maxKm) maxKm = distKm;
            }
            result.push(maxKm / 111.32);
        }
        return result;
    };

    const radii34 = getQuadrantMax(34);
    const radii50 = getQuadrantMax(50);
    const radii64 = getQuadrantMax(64);

    let newLat = updatedCyclone.lat + distanceDeg * Math.sin(angleRad);
    let newLon = updatedCyclone.lon + distanceDeg * Math.cos(angleRad) / Math.cos(updatedCyclone.lat * Math.PI / 180);
    updatedCyclone.lon = normalizeLongitude(newLon); 
    updatedCyclone.lat = newLat;
    updatedCyclone.track.push([updatedCyclone.lon, updatedCyclone.lat, updatedCyclone.intensity, updatedCyclone.isTransitioning, updatedCyclone.isExtratropical, updatedCyclone.circulationSize, updatedCyclone.isSubtropical, radii34, radii50, radii64, Math.round(currentCentralPressure)]);

    if (updatedCyclone.intensity < 17 || (updatedCyclone.isExtratropical && updatedCyclone.intensity < 24) || updatedCyclone.lat > 70 || updatedCyclone.lat < -70) {
        updatedCyclone.status = 'dissipated';
    }
    
    if (!updatedCyclone.named && updatedCyclone.intensity >= 34 && !updatedCyclone.isExtratropical) {
        updatedCyclone.named = true;
        const basinKey = updatedCyclone.basin || 'WPAC';
        const list = NAME_LISTS[basinKey] || NAME_LISTS['WPAC'];
        const safeIndex = nameIndex % list.length;
        updatedCyclone.name = list[safeIndex];
        console.log(`System upgraded to Tropical Storm ${updatedCyclone.name} (${basinKey})`);
    }
    
    return updatedCyclone;
}