/**
 * utils.js
 * 包含所有通用的、无状态的辅助函数。
 */
export const NAME_LISTS = {
    'WPAC': [
        'Damrey', 'Haikui', 'Kirogi', 'Yun-yeung', 'Koinu', 'Bolaven', 'Sanba', 'Jelawat', 'Ewiniar', 'Maliksi', 'Gaemi', 'Prapiroon', 'Maria', 'Son-Tinh',
        'Ampil', 'Wukong', 'Jongdari', 'Shanshan', 'Yagi', 'Leepi', 'Bebinca', 'Pulasan', 'Soulik', 'Cimaron', 'Jebi', 'Krathon', 'Barijat', 'Trami',
        'Kong-rey', 'Yinxing', 'Toraji', 'Man-yi', 'Usagi', 'Pabuk', 'Wutip', 'Sepat', 'Mun', 'Danas', 'Nari', 'Wipha', 'Francisco', 'Co-May',
        'Krosa', 'Bailu', 'Podul', 'Lingling', 'Kajiki', 'Nongfa', 'Peipah', 'Tapah', 'Mitag', 'Ragasa', 'Neoguri', 'Bualoi', 'Matmo', 'Halong',
        'Nakri', 'Fengshen', 'Kalmaegi', 'Fung-wong', 'Koto', 'Nokaen', 'Penha', 'Nuri', 'Sinlaku', 'Hagupit', 'Jangmi', 'Mekkhala', 'Higos', 'Bavi',
        'Maysak', 'Haishen', 'Noul', 'Dolphin', 'Kujira', 'Chan-hom', 'Peilou', 'Nangka', 'Saudel', 'Narra', 'Gaenari', 'Atsani', 'Etau', 'Bang-Lang',
        'Krovanh', 'Dujuan', 'Surigae', 'Choi-wan', 'Koguma', 'Champi', 'In-fa', 'Cempaka', 'Nepartak', 'Lupit', 'Mirinae', 'Nida', 'Omais', 'Luc-Binh',
        'Chanthu', 'Dianmu', 'Mindulle', 'Lionrock', 'Tokei', 'Namtheun', 'Malou', 'Nyatoh', 'Sarbul', 'Amuyao', 'Gosari', 'Chaba', 'Aere', 'Songda',
        'Trases', 'Mulan', 'Meari', 'Tsing-ma', 'Tokage', 'Ong-mang', 'Muifa', 'Merbok', 'Nanmadol', 'Talas', 'Hodu', 'Kulap', 'Roke', 'Sonca',
        'Nesat', 'Haitang', 'Jamjari', 'Banyan', 'Yamaneko', 'Pakhar', 'Sanvu', 'Mawar', 'Guchol', 'Talim', 'Bori', 'Khanun', 'Lan', 'Saobien'
    ],

    'NATL': [
        'Alberto', 'Beryl', 'Chris', 'Debby', 'Ernesto', 'Francine', 'Gordon', 'Helene', 'Isaac', 'Joyce', 'Kirk', 'Leslie', 'Milton', 'Nadine', 'Oscar', 'Patty', 'Rafael', 'Sara', 'Tony', 'Valerie', 'William',
        'Andrea', 'Barry', 'Chantal', 'Dexter', 'Erin', 'Fernand', 'Gabrielle', 'Humberto', 'Imelda', 'Jerry', 'Karen', 'Lorenzo', 'Melissa', 'Nestor', 'Olga', 'Pablo', 'Rebekah', 'Sebastien', 'Tanya', 'Van', 'Wendy',
        'Arthur', 'Bertha', 'Cristobal', 'Dolly', 'Edouard', 'Fay', 'Gonzalo', 'Hanna', 'Isaias', 'Josephine', 'Kyle', 'Leah', 'Marco', 'Nana', 'Omar', 'Paulette', 'Rene', 'Sally', 'Teddy', 'Vicky', 'Wilfred',
        'Ana', 'Bill', 'Claudette', 'Danny', 'Elsa', 'Fred', 'Grace', 'Henri', 'Idalia', 'Julian', 'Kate', 'Larry', 'Mindy', 'Nicholas', 'Odette', 'Peter', 'Rose', 'Sam', 'Teresa', 'Victor', 'Wanda',
        'Alex', 'Bonnie', 'Colin', 'Danielle', 'Earl', 'Farrah', 'Gaston', 'Hermine', 'Idris', 'Julia', 'Karl', 'Lisa', 'Martin', 'Nicole', 'Owen', 'Paula', 'Richard', 'Shary', 'Tobias', 'Virginie', 'Walter',
        'Arlene', 'Bret', 'Cindy', 'Don', 'Emily', 'Franklin', 'Gert', 'Harold', 'Idalia', 'Jose', 'Katia', 'Lee', 'Margot', 'Nigel', 'Ophelia', 'Philippe', 'Rina', 'Sean', 'Tammy', 'Vince', 'Whitney'
    ],
    
    'EPAC': [
        'Aletta', 'Bud', 'Carlotta', 'Daniel', 'Emilia', 'Fabio', 'Gilma', 'Hector', 'Ileana', 'John', 'Kristy', 'Lane', 'Miriam', 'Norman', 'Olivia', 'Paul', 'Rosa', 'Sergio', 'Tara', 'Vicente', 'Willa', 'Xavier', 'Yolanda', 'Zeke',
        'Alvin', 'Barbara', 'Cosme', 'Dalila', 'Erick', 'Flossie', 'Gil', 'Henriette', 'Ivo', 'Juliette', 'Kiko', 'Lorena', 'Mario', 'Narda', 'Octave', 'Priscilla', 'Raymond', 'Sonia', 'Tico', 'Velma', 'Wallis', 'Xina', 'York', 'Zelda'
    ],

    'NIO': [
        'Nisarga', 'Gati', 'Nivar', 'Burevi', 'Tauktae', 'Yaas', 'Gulab', 'Shaheen', 'Jawad', 'Asani', 'Sitrang', 'Mandous', 'Mocha',
        'Biparjoy', 'Tej', 'Hamoon', 'Michaung', 'Remal', 'Asna', 'Dana', 'Fengal', 'Shakthi', 'Montha', 'Senyar', 'Ditwah', 'Afoor',
        'Arnab', 'Muran', 'Uru', 'Ana', 'Baan', 'Phet', 'Gaur', 'Rahgu', 'Chhas', 'Ajar', 'Probaho', 'Jurzum', 'Bhumra',
        'Upakul', 'Aag', 'Vyom', 'Bojon', 'Jinkul', 'Pha', 'Shobha', 'Umban', 'Udita', 'Maha', 'Odi', 'Kenda', 'Ghenim',
        'Barshon', 'Neer', 'Gagan', 'Zum', 'Lisu', 'Yan', 'Prabhanjan', 'Titli', 'Teer', 'Ghuman', 'Ghambhira', 'Naseem', 'Pheru',
        'Nishit', 'Prabho', 'Jhar', 'Upana', 'Ambud', 'Singha', 'Ghurni', 'Viyana', 'Baru', 'Ghasha', 'Kurum', 'Saffar', 'Karo'
    ],

    'SIO': [
        'Alvaro', 'Belal', 'Candice', 'Djoungou', 'Eleanor', 'Filipo', 'Gamane', 'Hidaya', 'Ialy', 'Jeremy', 'Kanga', 'Ludzi', 'Melina', 'Nathan', 'Onias', 'Pelagie', 'Quamar', 'Rita', 'Solani', 'Tarik', 'Urilia', 'Vuyane', 'Wagner', 'Xusa', 'Yarona', 'Zacarias',
        'Ancha', 'Bheki', 'Chido', 'Dikeledi', 'Elvis', 'Faida', 'Garance', 'Hondwa', 'Ivone', 'Jude', 'Kanto', 'Lira', 'Maipelo', 'Njazi', 'Oscar', 'Pamela', 'Quentin', 'Rajab', 'Savana', 'Themba', 'Uyapo', 'Viviane', 'Walter', 'Xangy', 'Yemurai', 'Zanele',
        'Awa', 'Boura', 'Cerane', 'Diem', 'Eyram', 'Fani', 'Gumball', 'Helako', 'Izalia', 'Joalane', 'Kacha', 'Luka', 'Maia', 'Naima', 'Osman', 'Panda', 'Quenelle', 'Rashaka', 'Sweety', 'Tiana', 'Uzo', 'Valini', 'Wilson', 'Xila', 'Yezda', 'Zidane'
    ],

    'SHEM': [
        'Anika', 'Billy', 'Charlotte', 'Darian', 'Ellie', 'Freddy', 'Gabrielle', 'Herman', 'Ilsa', 'Jasper', 'Kirrily', 'Lincoln', 'Megan', 'Neville', 'Olga', 'Paul', 'Robyn', 'Sean', 'Tiffany', 'Urton', 'Vicki',
        'Alessia', 'Bruce', 'Catherine', 'Dylan', 'Edna', 'Fletcher', 'Gillian', 'Hadi', 'Ivana', 'Jack', 'Kate', 'Laszlo', 'Mingzhu', 'Nathan', 'Oriana', 'Quincey', 'Raquel', 'Stan', 'Tatiana', 'Uriah', 'Yvette',
        'Alfred', 'Blanche', 'Caleb', 'Dara', 'Ernie', 'Frances', 'Greg', 'Hilda', 'Irving', 'Joyce', 'Kelvin', 'Linda', 'Marco', 'Nora', 'Owen', 'Penny', 'Riley', 'Savannah', 'Trevor', 'Veronica', 'Wallace',
        'Ana', 'Bina', 'Cody', 'Dovi', 'Eva', 'Fili', 'Gina', 'Hale', 'Irene', 'Judy', 'Kevin', 'Lola', 'Mal', 'Nat', 'Osi', 'Peta', 'Rae', 'Sheila', 'Tam', 'Urmil', 'Vaianu', 'Wati', 'Xavier', 'Yani', 'Zita'
    ],

    'SATL': [
        'Arani', 'Bapu', 'Cari', 'Deni', 'Ecaí', 'Guará', 'Iba', 'Jaguar', 'Kurumí', 'Mani', 'Oquira', 'Potira', 'Raoni', 'Ubá', 'Yakecan',
        'Akará', 'Biguá', 'Caue', 'Domó', 'Endy', 'Guarani', 'Iguaçú', 'Jaci', 'Kaeté', 'Maracá', 'Okara', 'Poti', 'Reri', 'Sumé', 'Tupã',
        'Upaba', 'Votu', 'Ybba', 'Zeus'
    ]
};

const NOISE_CONFIG = {
    seed: 12345.67, // 随机种子
    baseScale: 25,  // [关键] 基底噪声的尺度（越大越平滑），建议 20-40
    detailScale: 8, // 细节噪声的尺度
    baseAmp: 1.5,   // 基底噪声幅度 (hPa)
    detailAmp: 0.5  // 细节噪声幅度 (hPa)
};

function pseudoNoise(x, y, seed) {
    // 使用质数乘法来打破周期性，模拟随机感
    const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
    return n - Math.floor(n);
}

function getSmoothNoise(lon, lat, scale, seed) {
    const x = lon / scale;
    const y = lat / scale;
    
    const i = Math.floor(x);
    const j = Math.floor(y);
    
    const fX = x - i;
    const fY = y - j;
    
    //缓动曲线 (Ease curve): 3t^2 - 2t^3，消除晶格感
    const u = fX * fX * (3.0 - 2.0 * fX);
    const v = fY * fY * (3.0 - 2.0 * fY);

    // 获取四个顶点的随机值
    const n00 = pseudoNoise(i, j, seed);
    const n10 = pseudoNoise(i + 1, j, seed);
    const n01 = pseudoNoise(i, j + 1, seed);
    const n11 = pseudoNoise(i + 1, j + 1, seed);

    // 双线性插值
    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;
    
    return nx0 * (1 - v) + nx1 * v;
}

export function calculateAtmosphericNoise(lon, lat) {
    // 层级 1: 大尺度波动 (决定主要的非线性气流)
    // 减去 0.5 是为了让噪声有正有负 (-0.5 到 0.5)
    const base = (getSmoothNoise(lon, lat, NOISE_CONFIG.baseScale, NOISE_CONFIG.seed) - 0.5) * 2;
    
    // 层级 2: 小尺度细节 (增加仿真感，但不影响大方向)
    const detail = (getSmoothNoise(lon, lat, NOISE_CONFIG.detailScale, NOISE_CONFIG.seed + 100) - 0.5) * 8;

    return (base * NOISE_CONFIG.baseAmp) + (detail * NOISE_CONFIG.detailAmp);
}

export const normalizeLongitude = (lon) => {
    // 健壮的标准化方法：确保结果在 [-180, 180] 之间
    let result = (lon + 180) % 360;
    if (result < 0) result += 360;
    return result - 180;
};

export const shortestLongitudeDistance = (lon1, lon2) => {
    let diff = lon1 - lon2;
    if (diff > 180) {
        diff -= 360;
    } else if (diff < -180) {
        diff += 360;
    }
    return diff;
};

export function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export const unwrapLongitude = (lon, referenceLon) => {
    if (isNaN(referenceLon)) return lon;
    let diff = lon - referenceLon;
    if (Math.abs(diff) > 180) {
        lon += (diff > 0) ? -360 : 360;
    }
    return lon;
};

export function calculateHollandPressure(r, Rm, Pc, Pn) {
    if (r <= 5) return Pc; // 极靠近中心时直接返回中心气压
    // 简化 Holland B 参数取 1.0
    return Pc + (Pn - Pc) * Math.exp(-Rm / r);
}

export function createGeoCircle(centerLon, centerLat, radiusKm, numPoints = 64) {
    const coords = [];
    const radiusRad = radiusKm / 6371; // 地球半径
    const lat1 = centerLat * Math.PI / 180;
    const lon1 = centerLon * Math.PI / 180;

    for (let i = 0; i <= numPoints; i++) {
        const bearing = (i / numPoints) * 2 * Math.PI;
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(radiusRad) +
                     Math.cos(lat1) * Math.sin(radiusRad) * Math.cos(bearing));
        const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(radiusRad) * Math.cos(lat1),
                     Math.cos(radiusRad) - Math.sin(lat1) * Math.sin(lat2));
        
        // 保持经度原始展开状态，不在此处强制 normalize
        coords.push([lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
    }
    return { type: "LineString", coordinates: coords };
}

export const getCategory = (windKts, isTransitioning = false, isExtratropical = false, isSubtropical = false) => {
    if (isSubtropical) {
        if (windKts < 34) return { name: "副热带低压", shortName: "SD", color: "#76d7c4" };
        return { name: "副热带风暴", shortName: "SS", color: "#48c9b0" };
    }
    if (isExtratropical) return { name: "温带气旋", shortName: "EXT", color: "#8e44ad" };
    if (isTransitioning) return { name: "正在温带转化", shortName: "ET", color: "#efcdeb" };
    if (windKts < 24) return { name: "低压区", shortName: "LPA", color: "#aaaaaa" };
    if (windKts < 34) return { name: "热带低压", shortName: "TD", color: "#6ec1ea" };
    if (windKts < 64) return { name: "热带风暴", shortName: "TS", color: "#4dffff" };
    if (windKts < 83) return { name: "1级飓风", shortName: "Cat 1", color: "#ffffd9" };
    if (windKts < 96) return { name: "2级飓风", shortName: "Cat 2", color: "#ffd98c" };
    if (windKts < 113) return { name: "3级飓风 (强)", shortName: "Cat 3", color: "#ff9e59" };
    if (windKts < 137) return { name: "4级飓风 (强)", shortName: "Cat 4", color: "#ff738a" };
    return { name: "5级飓风 (巨)", shortName: "Cat 5", color: "#8d75e6" };
};

export const knotsToKph = kts => Math.round(kts * 1.852);
export const knotsToMph = kts => Math.round(kts * 1.15078);

export const windToPressure = (windKts, circulationSize = 300, basin = 'WPAC', envPressure = null) => { let backgroundPressure = envPressure;
    if (backgroundPressure === null || backgroundPressure === undefined) {
        switch (basin) {
          case 'WPAC':
          case 'NIO':
              backgroundPressure = 1010; 
              break;
          default:
              backgroundPressure = 1018; 
        }
    }
    const basePressureCalc = backgroundPressure - 12.0 * (windKts ** 1.6) / (48.0) ** 1.6;
    const pressure = basePressureCalc + (basePressureCalc - backgroundPressure) * (0.0012 * circulationSize);
    return Math.max(640, Math.round(pressure));
};

// [已移除] unused pressureToWind function

export function getPressureAt(lon, lat, pressureSystemsLayer, useNoise = true) {
    let pressureValue = 1010; // 基础气压
    const safeLon = lon; 
    const systems = Array.isArray(pressureSystemsLayer) ? pressureSystemsLayer : (pressureSystemsLayer.lower || []);
    systems.forEach(cell => {
        const dx = shortestLongitudeDistance(safeLon, cell.x); 
        const dy = lat - cell.y;
        
        const exponent = -( ((dx**2) / (2 * cell.sigmaX**2)) + ((dy**2) / (2 * cell.sigmaY**2)) );
        let pressureOffset = Math.exp(exponent) * cell.strength;
        
        if (cell.noiseLayers) {
            let noise = 0;
            cell.noiseLayers.forEach(layer => {
                noise += Math.sin((safeLon + layer.offsetX) / layer.freqX) * Math.cos((lat + layer.offsetY) / layer.freqY) * layer.amplitude;
            });
            pressureValue += noise;
        }

        pressureValue += pressureOffset;
    });
    if (useNoise) {
        pressureValue += calculateAtmosphericNoise(lon, lat);
    }
    return pressureValue;
}

export const directionToCompass = deg => {
    const val = Math.floor((deg / 22.5) + 0.5);
    const arr = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return arr[(val % 16)];
};

// --- 洋流配置表 (重构优化) ---
const OCEAN_CURRENTS = [
    { name: "Cali", lat: 30, lon: -125, max: -3.0, sLat: 15, sLon: 50 },  // 加利福尼亚寒流
    { name: "Gulf", lat: 38, lon: -60,  max: 5.0,  sLat: 20, sLon: 30 },  // 北大西洋暖流
    { name: "SCS",  lat: 20, lon: 115,  max: -1.0, sLat: 20, sLon: 8, seasonal: true }, // 南海
    { name: "Canary", lat: 30, lon: -20, max: -4.5, sLat: 30, sLon: 45 }, // 加那利寒流
    { name: "Japan", lat: 27, lon: 140, max: 1.0,  sLat: 5,  sLon: 20 },  // 日本暖流
    { name: "GOM",   lat: 25, lon: -90, max: 3.0,  sLat: 7,  sLon: 10 },  // 墨西哥湾
    { name: "Somalia", lat: 10, lon: 50, max: -4.5, sLat: 10, sLon: 15 }, // 索马里寒流
    { name: "Benguela", lat: -25, lon: 5, max: -5.0, sLat: 15, sLon: 20 },// 本格拉寒流
    { name: "WestAus", lat: -35, lon: 105, max: -2.0, sLat: 15, sLon: 20 }, // 西澳寒流
    { name: "Peru", lat: -15, lon: -80, max: -6.0, sLat: 15, sLon: 20 }, // 秘鲁寒流
    { name: "Seq", lat: -10, lon: 100, max: 2.0, sLat: 5, sLon: 40 } // 南赤道暖流
];

export function getSST(lat, lon, month, globalTempK = 289) { 
    const BASELINE_TEMP_K = 289.0;
    const tempAnomaly = globalTempK - BASELINE_TEMP_K;
    
    const seasonalModifier = lat > 0 ? 2.8 + Math.cos((month - 8) * (Math.PI / 6)) * 1.7
    : 2.0 - Math.cos((month - 8) * (Math.PI / 6)) * 1.3;
    
    let baseSST = Math.abs(lat) < 12 ? (31.9 + 0.6 * tempAnomaly) : Math.max(10, (31.9 + 0.6 * tempAnomaly) - (Math.abs(lat) - 12) / seasonalModifier + Math.abs(lat / 60) ** 1.6);

    // [重构] 循环处理洋流调整
    let currentAdjustment = 0;
    
    OCEAN_CURRENTS.forEach(curr => {
        const dLon = shortestLongitudeDistance(lon, curr.lon);
        const dLat = lat - curr.lat;
        
        let maxEffect = curr.max;
        let sigmaLon = curr.sLon;

        // 特殊处理南海的季节性变化
        if (curr.seasonal) {
            maxEffect = -0.8 - 0.5 * Math.abs(month - 8);
            sigmaLon = 8 + Math.abs(month - 8);
        }

        const influence = Math.exp(-( (dLon**2) / (2 * sigmaLon**2) + (dLat**2) / (2 * curr.sLat**2) ));
        currentAdjustment += maxEffect * influence;
    });

    baseSST += currentAdjustment;
    return Math.max(0, Math.min(60, baseSST));
}