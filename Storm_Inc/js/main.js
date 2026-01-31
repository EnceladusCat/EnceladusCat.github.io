/**
 * main.js
 * 应用程序的入口点。负责状态管理、事件处理和协调其他模块。
 */

// 从各模块导入函数
import { getCategory, knotsToKph, knotsToMph, windToPressure, directionToCompass, getSST, calculateDistance, NAME_LISTS, getPressureAt } from './utils.js';
import { RadarRenderer, calculateRadarDbz, getShaderWindVector } from './radar-system.js';
import { DopplerRenderer } from './radar-doppler.js';
// [新增] 导入卫星云图模块
import { initSatelliteView, updateSatelliteView, resetSatelliteParams, setSatelliteGrayscale } from './satellite-view.js';
import { initTerrainSystem, getElevationAt, getLandStatus } from './terrain-data.js';
import { initializeCyclone, initializePressureSystems, updatePressureSystems, updateFrontalZone, updateCycloneState, getWindVectorAt } from './cyclone-model.js';
import { generatePathForecasts } from './forecast-models.js';
// [修改] 引入新的历史强度图绘制函数
import { drawMap, drawFinalPath, drawHistoricalIntensityChart, drawHumidityField, calculateBackgroundHumidity, calculateTotalHumidity, drawAllHistoryTracks, renderJTWCStyle, renderProbabilitiesStyle, drawStationGraph, renderPhaseSpace, startNewsAnimation, renderStationSynopticChart } from './visualization.js';
import { playClick, playToggleOn, playToggleOff, playStart, playError, playAlert, playUpgradeSound, playCat5Sound, toggleSFX } from './audio.js';

const checkLandWrapper = (lon, lat) => {
    const status = getLandStatus(lon, lat);
    return status.isLand; 
};

document.addEventListener('DOMContentLoaded', () => {

    // --- DOM 元素与全局状态 ---
    const generateButton = document.getElementById('generateButton');
    const pauseButton = document.getElementById('pauseButton');
    const catButton = document.getElementById('catButton');
    const newsModal = document.getElementById('newsModal');
    const closeNewsModal = document.getElementById('closeNewsModal');
    const newsCanvas = document.getElementById('newsCanvas');
    let stopNewsAnimation = null;
    const helpButton = document.getElementById('helpButton');
    const helpModal = document.getElementById('helpModal');
    const closeHelpModal = document.getElementById('closeHelpModal');
    const sfxButton = document.getElementById('sfxButton');
    const sfxIcon = sfxButton.querySelector('i');
    const irBwCheckbox = document.getElementById('irBwCheckbox');
    const basinSelector = document.getElementById('basinSelector');
    const monthSelector = document.getElementById('monthSelector');
    const leftContent = document.getElementById('left-hud-content');
    let selectedHistoryPointIndex = -1; // 记录当前选中的历史点
    const generateJTWCButton = document.getElementById('generateJTWCButton');
    const jtwcModal = document.getElementById('jtwcModal');
    const jtwcOutput = document.getElementById('jtwcOutput');
    const closeJtwcModal = document.getElementById('closeJtwcModal');
    const saveJtwcImage = document.getElementById('saveJtwcImage');
    let isLeftPanelCollapsed = false;
    let chartMode = 'kt';
    const tabKt = document.getElementById('tab-kt');
    const tabHpa = document.getElementById('tab-hpa');
    const togglePressureButton = document.getElementById('togglePressureButton');
    const toggleHumidityButton = document.getElementById('toggleHumidityButton');
    const toggleWindFieldButton = document.getElementById('toggleWindFieldButton');
    const toggleWindRadiiButton = document.getElementById('toggleWindRadiiButton');
    const windRadiiLegend = document.getElementById('wind-radii-legend');
    const radarLegend = document.getElementById('radar-legend');
    const dopplerLegend = document.getElementById('doppler-legend');
    const togglePathButton = document.getElementById('togglePathButton');
    const copyTrackButton = document.getElementById('copy-track-button');
    const downloadTrackButton = document.getElementById('download-track-button');
    const historyButton = document.getElementById('toggleHistoryButton'); 
    const historyModal = document.getElementById('historyModal');
    const historyHeader = historyModal.querySelector('.border-b');
    const closeHistoryModal = document.getElementById('closeHistoryModal');
    const historyList = document.getElementById('historyList');
    const bestTrackContainer = document.getElementById('best-track-container');
    const bestTrackData = document.getElementById('best-track-data');
    const historyBestTrackContainer = document.getElementById('history-best-track-container');
    const historyBestTrackData = document.getElementById('history-best-track-data');
    const downloadHistoryTrackButton = document.getElementById('downloadHistoryTrackButton');
    const mapContainer = d3.select("#map-container");
    const chartContainer = d3.select("#intensity-chart-container");
    const forecastContainer = document.getElementById('intensity-chart-section'); // [新增] 获取容器元素
    const tooltip = d3.select("body").append("div").attr("class", "tooltip");

    // [新增] 设置菜单 DOM 元素
    const settingsButton = document.getElementById('settingsButton');
    const settingsMenu = document.getElementById('settingsMenu');
    const musicButton = document.getElementById('musicButton');
    const musicMenu = document.getElementById('musicMenu');
    const musicListContainer = document.getElementById('musicListContainer');
    const bgmVolumeSlider = document.getElementById('bgmVolume');
    const bgmAudio = document.getElementById('bgmAudio');
    const globalTempSlider = document.getElementById('globalTempSlider');
    const globalTempValue = document.getElementById('globalTempValue');
    const globalShearSlider = document.getElementById('globalShearSlider');
    const globalShearValue = document.getElementById('globalShearValue');
    const siteNameInput = document.getElementById('siteNameInput');
    const siteLonInput = document.getElementById('siteLonInput');
    const siteLatInput = document.getElementById('siteLatInput');
    const customLonInput = document.getElementById('customLonInput');
    const customLatInput = document.getElementById('customLatInput');
    const showPathPointsCheckbox = document.getElementById('showPathPointsCheckbox');
    const savedSiteName = localStorage.getItem('tcs_site_name');
    const savedSiteLon = localStorage.getItem('tcs_site_lon');
    const savedSiteLat = localStorage.getItem('tcs_site_lat');
    const stats = new Stats();
    const musicTracks = [
        "WPAC - Barotropic.m4a",
        "NATL - Static.m4a",
        "EPAC - Void.m4a",
        "NIO - MayDay.m4a",
        "SIO - Westerlies.m4a",
        "SATL - Serendipity Land.m4a",
    ];
    let currentTrackIndex = -1;
    stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
    stats.dom.style.position = 'absolute'; // 样式调整以适应你的布局
    stats.dom.style.top = '0px';
    stats.dom.style.right = '0px'; 
    //document.body.appendChild(stats.dom);
    if(bgmAudio) bgmAudio.volume = 0.4;
    let radarRenderer = null;
    let dopplerRenderer = null; // [新增] 多普勒渲染器实例
    let radarOverlayCtx = null; // 用于画圆圈和线的2D Canvas
    let radarOverlayCanvas = null;
    const savedIrBw = localStorage.getItem('tcs_ir_bw') === 'true';
    if (irBwCheckbox) {
        irBwCheckbox.checked = savedIrBw;
        setSatelliteGrayscale(savedIrBw);
    }
    if (irBwCheckbox) {
        irBwCheckbox.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            setSatelliteGrayscale(isEnabled);
            if (typeof playClick === 'function') playClick();
            localStorage.setItem('tcs_ir_bw', isEnabled);
        });
    }
    if (historyHeader) {
        // 创建按钮容器以保持布局整洁
        const btnContainer = document.createElement('div');
        btnContainer.className = "flex gap-2 ml-auto mr-4"; // 放在右侧，关闭按钮左边

        const showAllBtn = document.createElement('button');
        showAllBtn.innerHTML = '<i class="fa-solid fa-earth-asia"></i> SHOW ALL';
        showAllBtn.className = "text-[10px] font-bold bg-cyan-900/50 hover:bg-cyan-700 text-cyan-300 border border-cyan-500/30 px-3 py-1 rounded transition-colors uppercase tracking-wider";
        
        showAllBtn.addEventListener('click', () => {
            if (state.history.length === 0) {
                    alert("没有历史记录可显示。");
                    return;
                }
            
                // 1. 关闭模态框
                historyModal.classList.add('hidden');
    
                // 2. 清理界面多余元素
                if (state.simulationInterval) clearInterval(state.simulationInterval);
                state.isPaused = false;
    
                // --- [修复开始] ---
                // 隐藏卫星云图窗口
                document.getElementById('satellite-window').classList.add('hidden');
                // 隐藏下方的“恢复卫星”按钮（如果存在）
                const restoreBtn = document.getElementById('restore-sat-btn');
                if(restoreBtn) restoreBtn.classList.add('hidden');

                // 隐藏整个信息面板容器 (不仅仅是内部文字)
                document.getElementById('info-panel').classList.add('hidden');
    
                // 隐藏其他组件
                document.getElementById('map-info-box').classList.add('hidden');
                document.getElementById('best-track-container').classList.add('hidden');
                forecastContainer.classList.add('hidden');
    
                // --- [修复结束] ---
    
                // 3. 更新状态栏文字 (为了让用户知道怎么退出，我们可以把状态写在顶部，或者让 Reset 按钮生效)
                // 由于 info-panel 隐藏了，原本的 'status' 元素也看不见了。
    
                // 4. 调用批量绘图
                drawAllHistoryTracks(mapSvg, mapProjection, state.history, state.world);
            });

        const closeBtn = document.getElementById('closeHistoryModal');
        historyHeader.insertBefore(showAllBtn, closeBtn);
    }

    // 创建一个独立的渲染循环来更新统计
    function animate() {
        stats.begin();
        // --- [新增/修改] 待机巡航模式 ---
        const hasTrackData = (state.cyclone && state.cyclone.track && state.cyclone.track.length > 1);
        if (state.radarMode || state.dopplerMode) {
                drawRadarScope();
        } else {
            if (radarCanvas && !radarCanvas.classList.contains('hidden')) {
                radarCanvas.classList.add('hidden');
            }
            if (radarOverlayCanvas && !radarOverlayCanvas.classList.contains('hidden')) {
                radarOverlayCanvas.classList.add('hidden');
                // 必须检查 ctx 是否存在
                if (radarOverlayCtx) {
                    radarOverlayCtx.clearRect(0, 0, radarOverlayCanvas.width, radarOverlayCanvas.height);
                }
            }
        }
        stats.end();
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);

    let state = {
        simulationInterval: null,
        isPaused: false,
        hasAlerted: false,
        hasTriggeredCat1News: false,
        hasTriggeredCat5News: false,
        simulationSpeed: 200,
        cyclone: {},
        selectedHistoryCyclone: null,
        pressureSystems: { upper: [], lower: [] },
        pressureHistory: [],
        frontalZone: {},
        pathForecasts: [],
        currentMonth: 7,
        world: null,
        showPressureField: false,
        showHumidityField: false,
        showPathForecast: false,
        showWindRadii: false,
        GlobalShear: 100,
        GlobalTemp: 289, // [新增] 全局温度状态，默认 289K (16°C)
        siteName: savedSiteName || '',
        siteLon: savedSiteLon ? parseFloat(savedSiteLon) : null,
        siteLat: savedSiteLat ? parseFloat(savedSiteLat) : null,
        radarMode: false,
        dopplerMode: false,
        customLon: null,
        customLat: null,
        showPathPoints: false,
        showWindField: false,
        history: [],
        simulationCount: 1,
        nextNameIndex: 0,
        selectedHistoryTrackData: '',
        lastFinalStats: null,
        currentSiteData: null,
        siteHistory: [],
        isSiteSelected: false,
        idleRotation: Math.random() * 50
    };

    let mapSvg, mapProjection;
    let radarCanvas, radarCtx;
    if (savedSiteName) siteNameInput.value = savedSiteName;
    if (savedSiteLon) siteLonInput.value = savedSiteLon;
    if (savedSiteLat) siteLatInput.value = savedSiteLat;
    generateButton.disabled = true;
    // --- 初始化与设置 ---

    function getEnglishCategoryName(knots, isExtra, isSub, basin) {
        if (isExtra) return "EXTRATROPICAL CYCLONE";
        if (isSub) return "SUBTROPICAL STORM";
        if (knots < 34) return "TROPICAL DEPRESSION";
        if (knots < 64) return "TROPICAL STORM";
        let term = "TYPHOON"; // 默认西太 (WPAC)
    
        // 美洲/大西洋 -> 飓风
        if (['EPAC', 'NATL', 'SATL'].includes(basin)) {
            term = "HURRICANE";
        } 
        // 印度洋/南半球 -> 气旋
        else if (['SHEM', 'SIO', 'NIO'].includes(basin)) {
            term = "CYCLONE";
        }

        // 2. 拼接等级
        if (knots < 83) return `${term} (CAT 1)`;
        if (knots < 96) return `${term} (CAT 2)`;
        if (knots < 113) return `${term} (CAT 3)`;
    
        return `SUPER ${term} (CAT ${knots < 137 ? '4' : '5'})`;
    }

    // [新增] 初始化卫星云图 WebGL 上下文
    initSatelliteView('satCanvas');

    function setupCanvases() {
        // A. SVG 重置 (保持不变)
        mapContainer.select("svg").remove();
        mapSvg = mapContainer.insert("svg", ":first-child")
            .attr("width", "100%")
            .attr("height", "100%")
            .style("z-index", "10")
            .style("pointer-events", "none"); 
        
        // B. 投影更新
        const { width, height } = mapContainer.node().getBoundingClientRect();
        let initLon = 120;
        let initLat = 15;
        if (typeof state !== 'undefined' && state.siteLon != null && state.siteLat != null) {
            initLon = state.siteLon;
            initLat = state.siteLat;
        } else if (typeof savedSiteLon !== 'undefined' && savedSiteLon) {
            // 兜底：如果 state 还没初始化，尝试读取顶部的全局变量
            initLon = parseFloat(savedSiteLon);
            initLat = parseFloat(savedSiteLat);
        }
        mapProjection = d3.geoEquirectangular()
            .scale(height / (20 * Math.PI / 180))
            .translate([width / 2, height / 2])
            .center([initLon, initLat]);

        if (!document.getElementById('interaction-fix-style')) {
            const style = document.createElement('style');
            style.id = 'interaction-fix-style';
            style.textContent = `
                /* 允许以下特定图层响应鼠标 */
                .track-interaction-layer, 
                .layer-pressure-handles, 
                .layer-ui,
                .layer-ui rect,
                .pressure-handle { 
                    pointer-events: auto !important; 
                    cursor: pointer;
                }
                
                /* 确保遮罩层本身虽然透明但能被点击 */
                .interaction-overlay {
                    pointer-events: auto !important;
                }
            `;
            document.head.appendChild(style);
        }

        // C. WebGL Canvas 初始化 (单例模式)
        // 只有当 radarRenderer 不存在时才创建，防止重复初始化导致 WebGL 上下文丢失
        radarCanvas = document.getElementById('radar-canvas-layer');
        if (radarCanvas) {
            // [修复核心 3]：双重保险，强制雷达 Canvas 穿透
            radarCanvas.style.pointerEvents = 'none'; 
            
            if (!radarRenderer) {
                radarCanvas.width = 256; 
                radarCanvas.height = 256;
                radarCanvas.style.opacity = "0.65";
                radarRenderer = new RadarRenderer(radarCanvas);
            }
            if (!dopplerRenderer) {
                dopplerRenderer = new DopplerRenderer(radarCanvas);
            }
        }

        // D. Overlay Canvas 初始化 (单例模式)
        if (!radarOverlayCanvas) {
            radarOverlayCanvas = document.getElementById('radar-overlay-layer');
            // 如果 HTML 里没写，动态创建
            if (!radarOverlayCanvas) {
                radarOverlayCanvas = document.createElement('canvas');
                radarOverlayCanvas.id = 'radar-overlay-layer';
                radarOverlayCanvas.className = "absolute top-0 left-0 w-full h-full pointer-events-none z-30 hidden";
                document.getElementById('map-container').appendChild(radarOverlayCanvas);
            }
            radarOverlayCtx = radarOverlayCanvas.getContext('2d');
        }
        
        // 确保 Overlay 尺寸匹配屏幕
        if (radarOverlayCanvas) {
            radarOverlayCanvas.style.pointerEvents = 'none';
            radarOverlayCanvas.width = width;
            radarOverlayCanvas.height = height;
        }
    }
        
    // --- 初始化流程 ---
    
    // 1. 先加载地图数据
    d3.json("Storm_Inc/js/world-f.json").then(data => {
        state.world = topojson.feature(data, data.objects.collection);
        
        // 2. 数据加载完，建立图层和投影
        setupCanvases();
        if (mapProjection && mapProjection.precision) {
            mapProjection.precision(3.1); // 值越大越快，0.1 是平衡点
        }
        // 3. 加载地形数据 (纹理)
        console.log("Loading Terrain Data...");
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = './js/elevation_1080x540.png';
        
        img.onload = () => {
            // A. JS 逻辑用的地形数据 (异步)
            initTerrainSystem(img.src, state.world).then(() => {
                console.log("Terrain Logic Ready.");
                generateButton.disabled = false;
            });
            
            // B. WebGL 渲染用的地形纹理 (同步上传)
            // 此时 setupCanvases 已经执行过，radarRenderer 一定存在
            if (radarRenderer) {
                radarRenderer.loadTerrainTexture(img);
                console.log("WebGL Terrain Texture Loaded.");
            }
            if (dopplerRenderer) {
                dopplerRenderer.loadTerrainTexture(img);
                console.log("Doppler Terrain Texture Loaded.");
            }
        };

        // 4. 绘制初始地图 (不需要等图片加载完，先画出来)
        drawMap(mapSvg, mapProjection, state.world, {status: null, track: []}, {
            pressureSystems: state.pressureSystems,
            showPressureField: state.showPressureField,
            showHumidityField: state.showHumidityField,
            showPathForecast: state.showPathForecast,
            showWindRadii: state.showWindRadii,
            siteName: state.siteName,
            siteLon: state.siteLon,
            siteLat: state.siteLat,
            showPathPoints: state.showPathPoints,
            showWindField: state.showWindField
        });
    });
    // 封装折叠/展开函数
    function toggleLeftPanel() {
        if (!leftContent) return;
        
        // 播放音效
        isLeftPanelCollapsed ? playToggleOn() : playToggleOff();
        
        isLeftPanelCollapsed = !isLeftPanelCollapsed;

        if (isLeftPanelCollapsed) {
            // 收缩
            leftContent.style.width = '0px';
            leftContent.style.opacity = '0';
            leftContent.style.paddingRight = '0'; 
            // 可选：添加一个小的提示音或视觉反馈
        } else {
            // 展开
            leftContent.style.width = ''; // 恢复 CSS 默认宽度
            leftContent.style.opacity = '100';
            leftContent.style.paddingRight = ''; 
        }
    }

    function updateTabUI() {
        [tabKt, tabHpa].forEach(btn => {
            btn.classList.remove('bg-cyan-600', 'text-white');
            btn.classList.add('text-slate-400');
        });
        const activeBtn = chartMode === 'kt' ? tabKt : tabHpa;
        activeBtn.classList.remove('text-slate-400');
        activeBtn.classList.add('bg-cyan-600', 'text-white');
    }

    function downloadMapImage(elementId, filename = 'cyclone_map.png') {
        const captureElement = document.getElementById(elementId);
        if (!captureElement) {
            console.error(`无法找到元素 #${elementId} 进行截图。`);
            alert("截图失败：未找到地图元素。");
            return;
        }

        // 1. 准备数据
        // A. 基础统计
        let peakWind = 0;
        let minPressure = 1010;
        const currentBasin = basinSelector.value || 'WPAC';
        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basinCode = basinMap[currentBasin] || 'XX';
        
        // 气旋编号 (如果没有 finalStats，使用当前计数)
        const cycloneNum = state.lastFinalStats ? state.lastFinalStats.number.split(' ')[1] : String(state.simulationCount).padStart(2, '0');
        const stormName = `${basinCode} ${cycloneNum}`;

        // B. 遍历轨迹获取极值
        if (state.cyclone && state.cyclone.track && state.cyclone.track.length > 0) {
            state.cyclone.track.forEach(p => {
                if (p[2] > peakWind) peakWind = p[2];
                let p_val;
                if (p[10] !== undefined) {
                    p_val = p[10];
                } else {
                    // 兼容旧数据
                    const envP = getPressureAt(p[0], p[1], state.pressureSystems);
                    p_val = windToPressure(p[2], p[5] || 300, currentBasin, envP);
                }

                if (p_val < minPressure) minPressure = p_val;
            });
        }

        // C. 计算日期范围 (MM/DD)
        const currentYear = new Date().getFullYear();
        // 模拟开始日期 (当月1号)
        const startDate = new Date(Date.UTC(currentYear, state.currentMonth - 1, 1));
        
        // 模拟结束日期 = 开始日期 + 气旋总寿命(小时)
        const totalHours = state.cyclone.age || 0;
        const endDate = new Date(startDate.getTime() + totalHours * 3600 * 1000);

        // 格式化日期函数 (07/15)
        const fmtDate = (date) => {
            const m = String(date.getUTCMonth() + 1).padStart(2, '0');
            const d = String(date.getUTCDate()).padStart(2, '0');
            return `${m}/${d}`;
        };
        const dateRangeStr = `${fmtDate(startDate)} ~ ${fmtDate(endDate)}`;


        // 2. 执行截图
        html2canvas(captureElement, {
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#111827', // 地图背景色
            logging: false
        }).then(canvas => {
            const ctx = canvas.getContext('2d');

            // --- 绘制 UI 面板 ---
            const panelX = 20;
            const panelY = 20;
            const panelWidth = 340;
            const panelHeight = 110;
            const radius = 12;

            ctx.save();
            // 绘制半透明圆角矩形背景
            ctx.fillStyle = 'rgba(17, 24, 39, 0.85)'; // 深色半透明
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'; // 淡淡的边框
            ctx.lineWidth = 1;

            ctx.beginPath();
            ctx.roundRect(panelX, panelY, panelWidth, panelHeight, radius);
            ctx.fill();
            ctx.stroke();

            // --- 绘制文字内容 ---
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            // 1. 标题行：编号 + 日期
            // 编号 (白色, 大号)
            ctx.font = 'bold 24px "JetBrains Mono", monospace';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(stormName, panelX + 20, panelY + 20);

            // 日期 (灰色, 小号, 紧跟在编号后面或右对齐)
            const nameWidth = ctx.measureText(stormName).width;
            ctx.font = '16px "JetBrains Mono", monospace';
            ctx.fillStyle = '#9ca3af'; // text-gray-400
            ctx.fillText(dateRangeStr, panelX + 20 + nameWidth + 15, panelY + 26);

            // 2. 数据行：强度 + 气压
            // 分割线
            ctx.beginPath();
            ctx.moveTo(panelX + 20, panelY + 55);
            ctx.lineTo(panelX + panelWidth - 20, panelY + 55);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.stroke();

            // 强度 (MAX ...)
            ctx.font = 'bold 20px "JetBrains Mono", monospace';
            
            // "MAX" 标签
            ctx.fillStyle = '#facc15'; // text-yellow-400
            ctx.fillText("MAX", panelX + 20, panelY + 70);
            
            // 数值
            const labelWidth = ctx.measureText("MAX ").width;
            ctx.fillStyle = '#ffffff';
            const windText = `${Math.round(peakWind)} KT`;
            ctx.fillText(windText, panelX + 20 + labelWidth, panelY + 70);

            // 气压 (MIN ...)
            const windTotalWidth = labelWidth + ctx.measureText(windText).width;
            const gap = 20; // 间距
            
            // "MIN" 标签
            ctx.fillStyle = '#22d3ee'; // text-cyan-400
            const pressureX = panelX + 20 + windTotalWidth + gap;
            ctx.fillText("MIN", pressureX, panelY + 70);
            
            // 数值
            const pLabelWidth = ctx.measureText("MIN ").width;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(`${Math.round(minPressure)} hPa`, pressureX + pLabelWidth, panelY + 70);

            ctx.restore();

            // --- 绘制底部水印 (保持不变) ---
            const disclaimerText = "GENERATED BY TCS-SIM | NOT REAL EVENT";
            ctx.font = '12px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.fillText(disclaimerText, panelX + 300, panelY + 125);

            // --- 导出 ---
            const link = document.createElement('a');
            link.href = canvas.toDataURL('image/png');
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }).catch(err => {
            console.error('html2canvas 截图失败:', err);
            alert("生成图像时出错。详情请查看控制台。");
        });
    }

    function downloadHistoryTrack() {
        if (state.selectedHistoryTrackData) {
            const blob = new Blob([state.selectedHistoryTrackData], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // 尝试从第一行解析出名称来命名文件
            const fileNameMatch = state.selectedHistoryTrackData.split('\n')[0].match(/^(\S+), (\S+)/);
            const fileName = fileNameMatch ? `${fileNameMatch[1]}${fileNameMatch[2]}.txt` : 'history_track.txt';
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            alert("没有可下载的历史轨迹数据。");
        }
    }
    // --- 辅助函数 ---
    function updateToggleButtonVisual(button, isActive) {
        if (isActive) {
            // 高亮状态: 更亮的背景, 亮青色文字, 青色边框
            button.classList.remove('bg-slate-900', 'text-slate-300', 'border-slate-600', 'hover:text-cyan-400');
            button.classList.add('bg-slate-700', 'text-cyan-400', 'border-cyan-500', 'shadow-md', 'shadow-cyan-900/20');
        } else {
            // 默认状态: 深色背景, 灰色文字
            button.classList.add('bg-slate-900', 'text-slate-300', 'border-slate-600', 'hover:text-cyan-400');
            button.classList.remove('bg-slate-700', 'text-cyan-400', 'border-cyan-500', 'shadow-md', 'shadow-cyan-900/20');
        }
    }

    function changeSimulationSpeed(newInterval) {
        state.simulationSpeed = newInterval;
        
        // 更新状态栏显示（可选，给你一个视觉反馈）
        const speedMap = { 50: 'MAX (3x)', 100: 'FAST (2x)', 200: 'NORMAL (1x)' };
        const speedText = speedMap[newInterval] || `${newInterval}ms`;
        
        // 如果当前正在运行（非暂停，且已启动），立即应用新速度
        if (state.simulationInterval && !state.isPaused && state.cyclone.status === 'active') {
            clearInterval(state.simulationInterval);
            state.simulationInterval = setInterval(updateSimulation, state.simulationSpeed);
            // 临时显示速度提示
            const originalStatus = document.getElementById('status').textContent;
            document.getElementById('status').textContent = `SPEED CHANGED: ${speedText}`;
            setTimeout(() => {
                // 如果还在运行，恢复原始状态文本
                if(state.simulationInterval) document.getElementById('status').textContent = "模拟进行中...";
            }, 1000);
        }
    }

    function getAtcfTypeCode(windKts, isExtratropical, isSubtropical) {
        if (isSubtropical) {
            if (windKts < 34) return 'SD';
            return 'SS';
        }
        if (isExtratropical) return 'EX';
        if (windKts >= 130) return 'ST';
        if (windKts >= 64) return 'TY';
        if (windKts >= 34) return 'TS';
        if (windKts >= 24) return 'TD';
        if (windKts > 0) return 'DB';
        return 'LO';
    }

    function formatBestTrack(track, cycloneInfo, simulationCount) {
        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basin = basinMap[cycloneInfo.basin] || 'WP';
        const cycloneNum = String(simulationCount).padStart(2, '0');
        const startDate = new Date(Date.UTC(cycloneInfo.year, cycloneInfo.month - 1, 1));

        return track.map((point, index) => {
            const currentDate = new Date(startDate);
            currentDate.setUTCHours(currentDate.getUTCHours() + index * 3);

            const dateString = `${currentDate.getUTCFullYear()}${String(currentDate.getUTCMonth() + 1).padStart(2, '0')}${String(currentDate.getUTCDate()).padStart(2, '0')}${String(currentDate.getUTCHours()).padStart(2, '0')}`;
            const lat = `${Math.round(point[1] * 10)}N`;
            let lonValue = point[0] > 180 ? 360 - point[0] : point[0];
            let lonHemi = point[0] > 180 ? 'W' : 'E';
            const lon = `${Math.round(lonValue * 10)}${lonHemi}`;
            const vmax = Math.round(point[2]);
            const circulationSize = point[5]; 
            let mslp;
            if (point[10] !== undefined) {
                mslp = point[10];
            } else {
                const circulationSize = point[5] || 300;
                const envP = getPressureAt(point[0], point[1], state.pressureSystems);
                mslp = Math.round(windToPressure(vmax, circulationSize, cycloneInfo.basin, envP));
            }
            
            const type = getAtcfTypeCode(vmax, point[4], point[6]);

            return [
                basin.padEnd(2, ' '), cycloneNum.padStart(3, ' '), ` ${dateString}`, ' 00', ' BEST', '   0',
                lat.padStart(6, ' '), lon.padStart(7, ' '), String(vmax).padStart(4, ' '),
                String(mslp).padStart(5, ' '), ` ${type}`,
            ].join(',');
        }).join('\n');
    }

    function drawRadarScope() {
        // 1. 基础检查
        if ((!state.radarMode && !state.dopplerMode) || !state.siteLon || !state.siteLat) {
            if (radarCanvas) radarCanvas.classList.add('hidden');
            if (radarOverlayCanvas) radarOverlayCanvas.classList.add('hidden');
            return;
        }
        if (!radarRenderer || !dopplerRenderer) return;
        radarCanvas.classList.remove('hidden');
        radarOverlayCanvas.classList.remove('hidden');

        // 2. 确定位置 (UI 层需要全屏分辨率)
        const { width, height } = mapContainer.node().getBoundingClientRect();
        if (radarOverlayCanvas.width !== width) {
            radarOverlayCanvas.width = width;
            radarOverlayCanvas.height = height;
        }

        const centerProj = mapProjection([state.siteLon, state.siteLat]);
        if (!centerProj) return;
        const [cx, cy] = centerProj;

        // 计算半径
        const refPoint = mapProjection([state.siteLon + (460 / 111), state.siteLat]);
        const radiusPx = Math.abs(refPoint[0] - cx);

        // ============================
        // A. 调用 WebGL 渲染 (极速)
        // ============================
        // WebGL 不需要擦除，它每一帧都是重画覆盖
        // 我们只需要更新 Canvas 的 CSS 位置，让它正好对准雷达区域
        
        // 技巧：我们不全屏渲染 WebGL，而是把 WebGL Canvas 作为一个小贴纸，定位到雷达区域
        const size = radiusPx * 2;
        radarCanvas.style.width = `${size}px`;
        radarCanvas.style.height = `${size}px`;
        radarCanvas.style.left = `${cx - radiusPx}px`;
        radarCanvas.style.top = `${cy - radiusPx}px`;
        const activeCyclone = (state.cyclone && state.cyclone.status === 'active') ? state.cyclone : null;
        if (state.dopplerMode) {
            // 多普勒模式：渲染径向速度
            dopplerRenderer.render(state, 256, 256);
            radarCanvas.style.opacity = "0.75"; // 多普勒模式稍微不透明一点，以便看清颜色
        } else if (state.radarMode) {
            // 基本反射率模式
            const rawHum = calculateBackgroundHumidity(
                state.siteLon, 
                state.siteLat, 
                state.pressureSystems, 
                state.currentMonth, 
                activeCyclone, 
                state.GlobalTemp
            );
            const normalizedHum = rawHum / 100.0;
            radarRenderer.render(state, 256, 256, normalizedHum);
            radarCanvas.style.opacity = "0.65";
        }

        // ============================
        // B. 绘制 UI (扫描线) - 使用 2D Canvas
        // ============================
        const ctx = radarOverlayCtx;
        ctx.clearRect(0, 0, width, height);
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1.5;
        
        // 裁剪区域 (只在圆内显示扫描线)
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
        ctx.clip(); // 限制绘制区域

        // 圆圈
        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2); 
        ctx.stroke();
        
        ctx.restore();
    }
    // --- UI更新函数 ---
    // [新增] 显示突发新闻 Banner
    function triggerNewsBanner(headlineHTML, subText, currentAge, currentMonth, type = 'ORANGE') {
        const container = document.getElementById('news-feed-container');
        if (!container) return;

        if (type === 'ORANGE') {
            playUpgradeSound(); // 升级台风：播放悦耳的 4 音符两遍
        } else if (type === 'RED') {
            playAlert(); // 进入警戒区：播放原本的空灵警报音
        } else if (type === 'PURPLE') {
            playCat5Sound();
        } else {
            playClick(); // 默认回退
        }

        // 1. 计算时间字符串
        const currentYear = new Date().getFullYear();
        const startDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
        const currentDate = new Date(startDate.getTime() + currentAge * 3600 * 1000);
        
        const m = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(currentDate.getUTCDate()).padStart(2, '0');
        const h = String(currentDate.getUTCHours()).padStart(2, '0');
        const dateStr = `${m}/${d} ${h}Z`;

        // 2. 设定颜色主题
        let themeColor = '#ea580c'; // 默认橙色 (Typhoon Upgrade)
        let borderColor = 'border-[#ea580c]';
        
        if (type === 'RED') { // 红色 (警报/进入范围)
            themeColor = '#dc2626'; 
            borderColor = 'border-[#dc2626]';
        }

        else if (type === 'PURPLE') {
            themeColor = '#a855f7'; // Purple-500 (亮紫色)
            borderColor = 'border-[#a855f7]';
        }

        // 3. 创建 DOM 元素
        const newsItem = document.createElement('div');
        // 初始状态：translate-x-full (在屏幕右侧外)
        newsItem.className = `transform translate-x-full transition-transform duration-500 ease-out flex flex-col items-end font-mono shadow-2xl pointer-events-auto`;
        
        // 构建内部 HTML (保持之前的 Newsletter 风格)
        newsItem.innerHTML = `
            <div class="text-white px-6 py-2 flex items-center gap-3 shadow-lg" style="background-color: ${themeColor}">
                <h2 class="text-xl md:text-2xl font-black uppercase tracking-tighter italic leading-none drop-shadow-md text-right">
                    ${headlineHTML}
                </h2>
                <div class="w-2 h-6 bg-white animate-pulse"></div>
            </div>
            <div class="bg-black/90 text-slate-300 px-6 py-1.5 border-r-4 ${borderColor} flex justify-between items-center gap-4 min-w-[300px] shadow-lg w-full">
                <span class="text-[10px] md:text-xs font-mono text-orange-400">
                    ${dateStr}
                </span>
                <span class="text-[10px] md:text-xs font-bold tracking-widest uppercase text-slate-400 text-right">
                    ${subText}
                </span>
            </div>
        `;

        // 4. 插入容器 (Append 实现向下堆叠)
        container.appendChild(newsItem);

        // 5. 触发进场动画 (需要下一帧执行，否则 transition 不生效)
        requestAnimationFrame(() => {
            newsItem.classList.remove('translate-x-full');
        });

        // 6. 设置自动销毁
        // 停留 6 秒后滑出
        setTimeout(() => {
            newsItem.classList.add('translate-x-full');
            
            // 等待滑出动画结束后(500ms)，从 DOM 中移除
            setTimeout(() => {
                if (newsItem.parentNode) {
                    newsItem.parentNode.removeChild(newsItem);
                }
            }, 500); // 对应 duration-500
        }, 6000);
    }

    function updateInfoPanel() {
        const cat = getCategory(state.cyclone.intensity, state.cyclone.isTransitioning, state.cyclone.isExtratropical, state.cyclone.isSubtropical);
        document.getElementById('simulationTime').textContent = `模拟时间: T+${state.cyclone.age} 小时`;
        document.getElementById('latitude').textContent = `${state.cyclone.lat.toFixed(1)}°N`;
        document.getElementById('longitude').textContent = `${state.cyclone.lon.toFixed(1)}°E`;
        document.getElementById('intensity').textContent = `${knotsToKph(state.cyclone.intensity)} kph (${knotsToMph(state.cyclone.intensity)} mph)`;
        const centerEnvP = getPressureAt(state.cyclone.lon, state.cyclone.lat, state.pressureSystems);
        const centralPressure = windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, state.cyclone.basin, centerEnvP);
        document.getElementById('pressure').textContent = `${centralPressure.toFixed(0)} hPa`;
        document.getElementById('category').textContent = cat.name;
        document.getElementById('ace').textContent = state.cyclone.ace.toFixed(2);
        document.getElementById('direction').textContent = `${directionToCompass(state.cyclone.direction)}`;
        document.getElementById('speed').textContent = `${state.cyclone.speed.toFixed(0)} kts`;
        const isLand = state.cyclone.isLand || false;
        const currentSST = getSST(state.cyclone.lat, state.cyclone.lon, state.currentMonth, state.GlobalTemp);
        const basin = basinSelector.value || 'WPAC'; // 默认西太
        const cycloneNum = String(state.simulationCount).padStart(2, '0');
        const intensity = state.cyclone.intensity;
        const isExtra = state.cyclone.isExtratropical;
        const isSub = state.cyclone.isSubtropical;
        let effectiveHumidity = 75;
        let peakWindSoFar = 0;
        if (state.cyclone.track) {
            state.cyclone.track.forEach(p => {
                if (p[2] > peakWindSoFar) peakWindSoFar = p[2];
            });
        }
        
        // 直接使用气旋对象里的名字，不再重新查表
        const stormName = state.cyclone.name ? state.cyclone.name.toUpperCase() : "UNKNOWN";
        let statusText = "";

        // 判定逻辑：只要巅峰风速达到过 34kt，或者已经获得命名(named标志位)
        if (peakWindSoFar >= 34 || state.cyclone.named) {
            // 已获得命名
            if (state.cyclone.intensity >= 34) {
                // 当前仍是风暴级以上 -> 显示名字 (或 EX-名字)
                if (state.cyclone.isExtratropical) statusText = `EX-${stormName}`;
                else statusText = stormName;
            } else {
                // 当前已减弱为低压，但保留名字 -> 显示 TD 名字
                if (state.cyclone.isExtratropical) statusText = `EX-${stormName}`; 
                else if (state.cyclone.isSubtropical) statusText = `SD ${stormName}`;
                else statusText = `TD ${stormName}`;
            }
        } else {
            // 尚未获得命名 -> 显示编号 (TD 01)
            if (state.cyclone.isExtratropical) statusText = `EX ${cycloneNum}`;
            else if (state.cyclone.isSubtropical) statusText = `SD ${cycloneNum}`;
            else statusText = `TD ${cycloneNum}`;
        }
        document.getElementById('status').textContent = statusText;

        if (state.cyclone && state.pressureSystems) {
            const samplingRadiusDeg = state.cyclone.circulationSize * 0.005;
            let envHumiditySum = 0;
            let minEnvHumidity = 60;
            const samplePoints = 12;

            for (let i = 0; i < samplePoints; i++) {
                const angleRad = (i / samplePoints) * 2 * Math.PI;
                // 计算采样点
                const sampleLon = state.cyclone.lon + samplingRadiusDeg * Math.cos(angleRad) / Math.cos(state.cyclone.lat * Math.PI / 180);
                const sampleLat = state.cyclone.lat + samplingRadiusDeg * Math.sin(angleRad);
                
                // 计算该点的背景湿度 (传入 globalTemp 计算 SST)
                const val = calculateBackgroundHumidity(
                    sampleLon, 
                    sampleLat, 
                    state.pressureSystems, 
                    state.currentMonth, 
                    state.cyclone,
                    state.GlobalTemp
                );
                
                envHumiditySum += val;
                
                if (val < minEnvHumidity) {
                    minEnvHumidity = val;
                }
            }
            
            const avgEnvHumidity = envHumiditySum / samplePoints;

            // B. 加权计
            effectiveHumidity = (minEnvHumidity * 0.4) + (avgEnvHumidity * 0.6);
        }

        // 3. 调用 updateSatelliteView (传入计算好的 effectiveHumidity)
        updateSatelliteView(
            state.cyclone.intensity, 
            state.cyclone.age, 
            state.cyclone.lat, 
            state.cyclone.isExtratropical, 
            state.cyclone.isSubtropical,
            isLand,
            currentSST,
            effectiveHumidity // <--- 使用加权后的湿度
        );
    }

    function updateMapInfoBox() {
        const cat = getCategory(state.cyclone.intensity, state.cyclone.isTransitioning, state.cyclone.isExtratropical, state.cyclone.isSubtropical);
        document.getElementById('map-info-time').textContent = `T+${state.cyclone.age}h`;
        document.getElementById('map-info-intensity').textContent = `${cat.shortName} - ${state.cyclone.intensity.toFixed(0)}KT`;
        const centerEnvP = getPressureAt(state.cyclone.lon, state.cyclone.lat, state.pressureSystems);
        const pVal = windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, state.cyclone.basin, centerEnvP);
        
        document.getElementById('map-info-movement').textContent = `${pVal.toFixed(0)}hPa ${directionToCompass(state.cyclone.direction)} ${state.cyclone.speed.toFixed(0)}KT`;
    }
    
    function updateStateSiteData() {
        if (state.siteLon != null && state.siteLat != null) {
            
            // 1. 获取原始风场
            // 注意：即使气旋未生成，这里也能算出背景风场
            let vec = getWindVectorAt(state.siteLon, state.siteLat, state.currentMonth, state.cyclone, state.pressureSystems);
            
            // ... (中间的陆地摩擦逻辑保持不变) ...
            if (state.world) {
                const isLand = state.world.features.some(feature => d3.geoContains(feature, [state.siteLon, state.siteLat]));
                if (isLand) {
                    vec.magnitude *= 0.78;
                    vec.u *= 0.78;
                    vec.v *= 0.78;
                } else {
                    // 近岸判定 (复用之前的逻辑)
                    const nearThreshold = 0.1; // 约50km
                    const isNearShore = state.world.features.some(feature => {
                        const geometry = feature.geometry;
                        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
                        return polygons.some(poly => poly.some(ring => ring.some(vertex => {
                            let dx = Math.abs(vertex[0] - state.siteLon);
                            if (dx > 180) dx = 360 - dx; 
                            const dy = Math.abs(vertex[1] - state.siteLat);
                            return dx < nearThreshold && dy < nearThreshold;
                        })));
                    });

                    if (isNearShore) {
                        vec.magnitude *= 0.89; 
                        vec.u *= 0.89;
                        vec.v *= 0.89;
                    }
                }
            }
            
            const speedKt = Math.round(vec.magnitude + Math.random());

            // 3. 计算风向字符串
            const flowAngleMath = Math.atan2(-vec.v, vec.u) * (180 / Math.PI);
            let windDir = (flowAngleMath + 250) % 360;
            if (windDir < 0) windDir += 360;
            const dirText = directionToCompass(windDir);

            // [新增] 计算雷达反射率并判断天气图标
            const dbz = calculateRadarDbz(state.siteLon, state.siteLat, state);
            
            let weatherIcon = '<i class="fa-solid fa-sun text-yellow-500"></i>'; // 默认晴天
            const isNight = false; // 简化的昼夜逻辑，你可以扩展它

            // 简单的天气判定逻辑
            if (dbz >= 50) {
                weatherIcon = '<i class="fa-solid fa-cloud-bolt text-yellow-500"></i>';
            } else if (dbz >= 35) {
                weatherIcon = '<i class="fa-solid fa-cloud-showers-heavy text-blue-500"></i>'; // 大雨
            } else if (dbz >= 15) {
                weatherIcon = '<i class="fa-solid fa-cloud-rain text-blue-400"></i>'; // 中雨
            } else if (dbz >= 5) {
                weatherIcon = '<i class="fa-solid fa-cloud text-slate-400"></i>'; // 阴天/多云
            } else {
                weatherIcon = '<i class="fa-solid fa-sun text-yellow-500"></i>';
            }

            // 构建包含 HTML 的 Label
            // 使用 span 调整间距
            const label = `${weatherIcon} <span style="margin-left:2px;">${dirText}</span> / ${speedKt}KT`;
            let localPressure = 1010; // 默认值
            // 1. 获取当前模拟时间的 UTC 小时数
            // state.cyclone.age 是模拟开始后的累计小时数
            // 假设模拟通常从 00Z 或 06Z 开始并不重要，关键是相对变化
            const currentSimHour = (state.cyclone && state.cyclone.age) ? state.cyclone.age : 0;
            
            // 2. 计算当地平太阳时 (LMT)
            // 经度每 15 度相差 1 小时
            const localHour = (currentSimHour + state.siteLon / 15) % 24;

            // 3. 计算半日潮 (Semi-diurnal Tide)
            // 规律：每天有两个高点 (10:00, 22:00) 和两个低点 (04:00, 16:00)
            // 使用余弦波模拟：Cos((Hour - 10) / 12 * 2π)
            // 当 Hour=10 时，Cos(0)=1 (最高)；当 Hour=16 时，Cos(π)=-1 (最低)
            
            // 振幅纬度修正：赤道最强 (~1.6 hPa)，两极最弱 (~0 hPa)
            const latFactor = Math.max(0, Math.cos(state.siteLat * Math.PI / 180));
            const tideAmplitude = 1.6 * latFactor; 
            
            const diurnalBias = tideAmplitude * Math.cos(((localHour - 10) / 12) * 2 * Math.PI);

            // 4. 叠加微小随机噪声 (模拟测量误差/微湍流)
            const microNoise = (Math.random() - 0.5) * 0.2;
            const Pn = getPressureAt(state.siteLon, state.siteLat, state.pressureSystems);
            if (state.cyclone && state.cyclone.status === 'active') {
                const distKm = calculateDistance(state.cyclone.lat, state.cyclone.lon, state.siteLat, state.siteLon);
                const Rm = 10 + state.cyclone.circulationSize * 0.25;
                const centerEnvP = getPressureAt(state.cyclone.lon, state.cyclone.lat, state.pressureSystems);
                const Pc = windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, basinSelector.value, centerEnvP);
    
                // 基础气压 (Holland 模型)
                const baseP = Pc + (Pn - Pc) * Math.exp(-Rm / Math.max(1, distKm));
                
                // 叠加潮汐修正
                localPressure = baseP + diurnalBias + microNoise;
            } else {
                localPressure = Pn + diurnalBias + microNoise;
            }

            // 4. 更新 State
            state.currentSiteData = {
                u: vec.u,
                v: vec.v,
                magnitude: vec.magnitude,
                displaySpeed: speedKt,
                label: label, // 现在这是 HTML 字符串
                dbz: dbz,     // 保存 dBZ 数值备用
                pressure: localPressure,
                isSelected: state.isSiteSelected
            };
        } else {
            state.currentSiteData = null;
        }
    }

    // --- 核心模拟循环 ---

    function updateSimulation() {
        if (state.cyclone.status !== 'active') {
            clearInterval(state.simulationInterval);
            state.simulationInterval = null;
            state.isPaused = false;
            
            // --- 变量统一区域 (彻底解决命名混乱) ---
            const basinId = basinSelector.value || 'WPAC'; // 下拉菜单的值 (用于查名字表), 例如 "WPAC"
            const cycloneInfo = {
                basin: basinId,
                month: state.currentMonth,
                year: new Date().getFullYear()
            };
            
            // 生成最佳路径文本
            const bestTrackText = formatBestTrack(state.cyclone.track, cycloneInfo, state.simulationCount);
            
            // 解析简写代码 (用于显示编号), 例如 "WP"
            const firstLine = bestTrackText.split('\n')[0];
            const basinCode = firstLine.split(',')[0].trim(); 
            const cycloneNumStr = String(state.simulationCount).padStart(2, '0');
            
            // -------------------------------------

            // 1. 遍历轨迹计算极值 (Peak Wind & Min Pressure)
            let peakWind = 0;
            let minPressure = 9999;
            state.cyclone.track.forEach(point => {
                const intensity = point[2];
                let pressure;
                if (point[10] !== undefined && point[10] !== null) {
                    pressure = point[10];
                } else {
                    // 兼容旧存档的回退逻辑 (只有读取旧版存档时才会执行这里)
                    const circulationSize = point[5] || 300;
                    // 注意：事后反算无法获取当时的环境气压，只能用默认值，这是造成不一致的根源
                    // 但对于新模拟，point[10] 一定存在，所以不会进这里
                    pressure = Math.round(windToPressure(intensity, circulationSize, basinId)); 
                }

                if (intensity > peakWind) peakWind = intensity;
                if (pressure < minPressure) minPressure = pressure;
            });

            // 2. 获取名字 (使用 basinId 查表)
            const cycloneNum = String(state.simulationCount).padStart(2, '0');
            const stormName = state.cyclone.name ? state.cyclone.name.toUpperCase() : "UNKNOWN";
            let statusText = "";

            // 逻辑与 updateInfoPanel 完全一致
            if (peakWind >= 34 || state.cyclone.named) {
                if (state.cyclone.intensity >= 34) {
                    if (state.cyclone.isExtratropical) statusText = `EX-${stormName}`;
                    else statusText = stormName;
                } else {
                    if (state.cyclone.isExtratropical) statusText = `EX-${stormName}`;
                    else if (state.cyclone.isSubtropical) statusText = `SD ${stormName}`;
                    else statusText = `TD ${stormName}`;
                }
            } else {
                if (state.cyclone.isExtratropical) statusText = `EX ${cycloneNum}`;
                else if (state.cyclone.isSubtropical) statusText = `SD ${cycloneNum}`;
                else statusText = `TD ${cycloneNum}`;
            }
            // 更新 UI
            document.getElementById('status').textContent = statusText;
            document.getElementById('map-info-box').classList.add('hidden');
            
            // 重置按钮状态
            pauseButton.disabled = true;
            pauseButton.innerHTML = '<i class="fa-solid fa-pause text-xs"></i>';
            monthSelector.disabled = false;
            basinSelector.disabled = false;
            globalTempSlider.disabled = false;
            globalShearSlider.disabled = false;
            siteNameInput.disabled = false;
            customLonInput.disabled = false;
            customLatInput.disabled = false;
            siteLonInput.disabled = false;
            siteLatInput.disabled = false;

            // 4. 创建最终统计对象 (使用 basinCode 组合编号, 如 "WP 01")
            const finalStats = {
                number: `${basinCode} ${cycloneNumStr}`,
                peakWind: Math.round(peakWind),
                minPressure: Math.round(minPressure),
                ace: state.cyclone.ace.toFixed(2)
            };
            state.lastFinalStats = finalStats;

            // 5. 绘图
            // 注意：这里传给 drawFinalPath 的是 basinId (selector value)，因为它可能需要用来确定颜色逻辑等
            drawFinalPath(mapSvg, mapProjection, state.cyclone, state.world, tooltip, state.siteName, state.siteLon, state.siteLat, state.showPathPoints, finalStats, basinId, state.pressureSystems, state.showWindField);
            requestRedraw();
            
            forecastContainer.classList.remove('hidden');
            setTimeout(() => {
                drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip);
            }, 0);

            bestTrackData.value = bestTrackText;
            bestTrackContainer.classList.remove('hidden');
            copyTrackButton.textContent = "复制数据";

            // 6. 保存历史记录
            try {
                const totalHours = state.cyclone.age;
                const peakIntensityKt = Math.round(peakWind);
                
                // 历史列表显示的名称
                const historyName = `${statusText} (${basinCode} ${cycloneNumStr}) - T+${totalHours}h, Peak ${peakIntensityKt}kt`;

                state.history.push({ 
                    name: historyName, 
                    cycloneData: JSON.parse(JSON.stringify(state.cyclone)),
                    atcfData: bestTrackText,
                    pressureHistory: JSON.parse(JSON.stringify(state.pressureHistory || [])),
                    siteHistory: JSON.parse(JSON.stringify(state.siteHistory || []))
                });
                state.simulationCount++;
            } catch (e) {
                console.error("无法保存历史记录:", e);
            }
            return;
        }        // [修改] 传递 GlobalTemp 到模型
        const wasNamed = state.cyclone.named;
        state.pressureSystems = updatePressureSystems(state.pressureSystems, state.cyclone.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.frontalZone = updateFrontalZone(state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.cyclone = updateCycloneState(state.cyclone, state.pressureSystems, state.frontalZone, state.world, state.currentMonth, state.GlobalTemp, state.GlobalShear, state.nextNameIndex);
        state.cyclone.currentMonth = state.currentMonth;
        if (state.cyclone.status === 'active') {
            // 为了节省内存，我们只存 keyframe (比如对应 track 的每一个点)
            // 假设 updateTimer 触发 track 更新时刻：
            
            // 深拷贝当前的气压系统状态 (非常关键！必须切断引用)
            const snapshot = {
                age: state.cyclone.age, // 时间戳，用于对齐
                month: state.cyclone.currentMonth, // 记录当时的月份(影响SST等)
                // 只存 lower 层即可，因为天气图主要画地面场
                lower: JSON.parse(JSON.stringify(state.pressureSystems.lower || [])),
                upper: JSON.parse(JSON.stringify(state.pressureSystems.upper || [])) // 如果以后要画高空图也可以存
            };
            
            // 存入历史数组
            state.pressureHistory.push(snapshot);
        }
        if (!wasNamed && state.cyclone.named) {
            state.nextNameIndex++;
            console.log("Name assigned. Next name index:", state.nextNameIndex);
        }

        if (!state.hasTriggeredCat1News && state.cyclone.intensity >= 64 && !state.cyclone.isExtratropical) {
            state.hasTriggeredCat1News = true; // 锁定，防止重复触发
            
            // 获取名字 (如果没有名字显示编号)
            const cycloneNum = String(state.simulationCount).padStart(2, '0');
            const displayName = state.cyclone.name ? state.cyclone.name.toUpperCase() : `SYSTEM ${cycloneNum}`;
            const currentBasinId = basinSelector.value; 

            let stormTerm = "HURRICANE";
            if (currentBasinId === 'WPAC') stormTerm = "TYPHOON";
            else if (['NIO', 'SIO', 'SHEM'].includes(currentBasinId)) { stormTerm = "CAT-1 CYCLONE"; }
            
            // 构建 HTML 标题
            const headlineHTML = `${displayName} <span class="text-black/50 text-base align-middle not-italic ml-2 font-bold">HAS BECOME A ${stormTerm}</span>`;

            // [修改] 调用新函数，类型为 ORANGE
            triggerNewsBanner(headlineHTML, "BREAKING NEWSLETTER", state.cyclone.age, state.currentMonth, 'ORANGE');
        }
        
        if (!state.hasTriggeredCat5News && state.cyclone.intensity >= 137 && !state.cyclone.isExtratropical) {
            state.hasTriggeredCat5News = true;
            
            const cycloneNum = String(state.simulationCount).padStart(2, '0');
            const displayName = state.cyclone.name ? state.cyclone.name.toUpperCase() : `SYSTEM ${cycloneNum}`;
            const currentBasinId = basinSelector.value;

            // 术语区分：西太叫“超强台风”，其他叫“五级飓风”
            let statusTerm = "CATEGORY 5 HURRICANE";
            if (currentBasinId === 'WPAC') {
                statusTerm = "CAT-5 SUPER TYPHOON";
            }

            // 构建标题 HTML (紫色高亮风格)
            // 注意：这里使用 font-black 加粗，让 Cat 5 看起来更具压迫感
            const headlineHTML = `${displayName} <span class="text-black/60 text-base align-middle not-italic ml-2 font-black">ACHIEVED ${statusTerm} STATUS</span>`;

            // 调用新闻条 (类型为 PURPLE)
            triggerNewsBanner(headlineHTML, "EXTREME INTENSITY ALERT", state.cyclone.age, state.currentMonth, 'PURPLE');
        }

        if (state.siteLon != null && state.siteLat != null) {
            const dist = calculateDistance(state.cyclone.lat, state.cyclone.lon, state.siteLat, state.siteLon);
            
            // 阈值：400km
            if (dist <= 400 && state.cyclone.intensity >= 34) {
                // 只有当之前没有报警过时，才播放
                if (!state.hasAlerted) {
                    playAlert(); // 播放空灵科技音效
                    state.hasAlerted = true; // 锁定，防止下一帧重复播放
                    
                    // 可选：在控制台或界面给出一个小的视觉提示
                    console.log(`Alert: Cyclone entered 400km radius (${Math.round(dist)}km)`);
const cycloneNum = String(state.simulationCount).padStart(2, '0');
                    const displayName = state.cyclone.name ? state.cyclone.name.toUpperCase() : `SYSTEM ${cycloneNum}`;
                    const siteName = state.siteName ? state.siteName.toUpperCase() : "OBSERVATION POST";

                    // 构建标题 HTML (红色警报风格)
                    const headlineHTML = `ALERT: <span class="text-white text-base align-middle not-italic ml-2 font-bold">${displayName} ENTERED 400KM WARNING RANGE</span>`;
                    
                    // 调用函数，类型为 RED
                    triggerNewsBanner(headlineHTML, `THREAT TO ${siteName}`, state.cyclone.age, state.currentMonth, 'RED');
                }
            } else {
                // 如果气旋离开了 800km 范围，重置标志
                // 这样如果它回头再次进入，会再次报警
                state.hasAlerted = false; 
            }
        }

        updateInfoPanel();
        updateMapInfoBox();
        updateStateSiteData();

        // 存入历史 (保持原有逻辑，因为这里是随时间推进的)
        if (state.currentSiteData) {
            const currentHour = state.cyclone.age;
            const lastEntry = state.siteHistory[state.siteHistory.length - 1];
            if (!lastEntry || lastEntry.hour !== currentHour) {
                 state.siteHistory.push({
                    hour: currentHour,
                    // 核心数据
                    wind: state.currentSiteData.displaySpeed,
                    pressure: state.currentSiteData.pressure,
                    // 矢量分量 (用于反推风向)
                    u: state.currentSiteData.u,
                    v: state.currentSiteData.v,
                    // 天气数据
                    dbz: state.currentSiteData.dbz,
                    // 记录当时的站点位置，以防用户后来改了位置导致数据错位
                    lat: state.siteLat,
                    lon: state.siteLon
                });
            }
        }

        drawMap(mapSvg, mapProjection, state.world, state.cyclone, {
            pathForecasts: state.pathForecasts,
            pressureSystems: state.pressureSystems,
            showPressureField: state.showPressureField,
            showHumidityField: state.showHumidityField,
            showPathForecast: state.showPathForecast,
            showWindRadii: state.showWindRadii,
            siteName: state.siteName,
            siteLon: state.siteLon,
            siteLat: state.siteLat,
            showPathPoints: state.showPathPoints,
            showWindField: state.showWindField,
            month: state.currentMonth,
            siteHistory: state.siteHistory,
            siteData: state.currentSiteData,
            onSiteClick: () => { 
                state.isSiteSelected = !state.isSiteSelected;
                requestRedraw();
            }
        });
        
        if (state.cyclone.age % 3 === 0 && state.cyclone.age > 0) {
             const forecasts = generatePathForecasts(state.cyclone, state.pressureSystems, checkLandWrapper, state.GlobalTemp, state.GlobalShear);
             state.pathForecasts = forecasts;
             if (state.cyclone.age % 6 === 0 && state.cyclone.age > 0) {
                 if (!state.cyclone.forecastLogs) state.cyclone.forecastLogs = {};
                 state.cyclone.forecastLogs[state.cyclone.age] = JSON.parse(JSON.stringify(forecasts));
             }
        }
        if (state.cyclone.track.length > 3) {
            generateJTWCButton.classList.remove('hidden');
        }
    }

    function startSimulation() {
        playStart();
        selectedHistoryPointIndex = -1;
        if (state.simulationInterval) clearInterval(state.simulationInterval);
        state.isPaused = false;
        state.hasAlerted = false;
        state.hasTriggeredCat1News = false;
        state.hasTriggeredCat5News = false;
        state.siteHistory = []; 
        state.pressureHistory = [];
        state.isSiteSelected = false;
        state.selectedHistoryCyclone = null;
        if (!state.world) return;
        resetSatelliteParams();
        setupCanvases();
        document.getElementById('initial-message').classList.add('hidden');
        document.getElementById('simulation-output').classList.remove('hidden');
        document.getElementById('satellite-window').classList.remove('hidden');
        document.getElementById('info-panel').classList.remove('hidden');
        const restoreBtn = document.getElementById('restore-sat-btn');
        if (restoreBtn) restoreBtn.classList.add('hidden');
        const newsContainer = document.getElementById('news-feed-container');
        if (newsContainer) {
            newsContainer.innerHTML = ''; // 直接清空所有子元素
        }
        forecastContainer.classList.add('hidden');
        document.getElementById('map-info-box').classList.remove('hidden');
        bestTrackContainer.classList.add('hidden');
        
        // [UI修复] 使用 innerHTML 设置带图标的按钮，保持风格一致
        generateButton.innerHTML = '<span class="relative z-10 flex items-center justify-center gap-2"><i class="fa-solid fa-power-off"></i> RESTART</span>';
        pauseButton.disabled = false;
        // [UI修复] 设置为暂停图标
        pauseButton.innerHTML = '<i class="fa-solid fa-pause text-xs"></i>';
        
        const selectedBasin = basinSelector.value;
        if (!state.lastBasin || state.lastBasin !== selectedBasin) {
            const list = NAME_LISTS[selectedBasin] || NAME_LISTS['WPAC'];
            state.nextNameIndex = Math.floor(Math.random() * list.length);
        }
        state.lastBasin = selectedBasin;
        state.currentMonth = parseInt(monthSelector.value, 10);
        monthSelector.disabled = true;
        basinSelector.disabled = true;
        // [修改] 禁用设置滑块
        globalTempSlider.disabled = true;
        globalShearSlider.disabled = true;
        siteNameInput.disabled = true;
        customLonInput.disabled = true;
        customLatInput.disabled = true;
        siteLonInput.disabled = true;
        siteLatInput.disabled = true;
        settingsMenu.classList.add('hidden'); // [修改] 开始模拟时隐藏菜单

        // [修改] 传递 GlobalTemp 到模型
        state.cyclone = initializeCyclone(state.world, state.currentMonth, selectedBasin, state.GlobalTemp, state.GlobalShear, state.customLon, state.customLat); 
        state.cyclone.track.push([state.cyclone.lon, state.cyclone.lat, state.cyclone.intensity, false, false, state.cyclone.circulationSize, state.cyclone.isSubtropical]);
        state.pressureSystems = initializePressureSystems(state.cyclone, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.frontalZone = updateFrontalZone(state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        
        state.pathForecasts = generatePathForecasts(state.cyclone, state.pressureSystems, checkLandWrapper, state.GlobalTemp, state.GlobalShear);
        updateToggleButtonVisual(togglePressureButton, state.showPressureField);
        updateToggleButtonVisual(toggleWindRadiiButton, state.showWindRadii);
        updateToggleButtonVisual(togglePathButton, state.showPathForecast);
        state.simulationInterval = setInterval(updateSimulation, state.simulationSpeed);
    }
    
    function togglePause() {
        if (!state.cyclone.status || state.cyclone.status !== 'active') {
            playError(); // [新增] 如果无法暂停（未激活），播放错误音
            return;
        }
        playClick();
        state.isPaused = !state.isPaused;
        if (state.isPaused) {
            clearInterval(state.simulationInterval);
            state.simulationInterval = null;
            // [UI修复] 暂停状态显示播放图标
            pauseButton.innerHTML = '<i class="fa-solid fa-play text-xs"></i>';
            document.getElementById('status').textContent = "模拟已暂停";
            requestRedraw();
        } else {
            state.simulationInterval = setInterval(updateSimulation, state.simulationSpeed);
            // [UI修复] 运行状态显示暂停图标
            pauseButton.innerHTML = '<i class="fa-solid fa-pause text-xs"></i>';
            updateInfoPanel();
        }
    }

    function requestRedraw() {
        // 1. 确保在重绘前更新站点数据
        updateStateSiteData();
        // 2. 【核心】检查气旋状态，控制显示标志
        const isCycloneActive = state.cyclone && state.cyclone.status === 'active';
        const onSiteClickCallback = () => {
            state.isSiteSelected = !state.isSiteSelected;
            requestRedraw();
        };
        if (state.world && mapSvg) {
            if (isCycloneActive || !state.cyclone.track || state.cyclone.track.length < 2) {
        // 如果模拟结束，强制隐藏所有气旋相关的动态元素
                const forecasts = isCycloneActive ? state.pathForecasts : [];
                const showRadii = isCycloneActive && state.showWindRadii;
                const showForecast = isCycloneActive && state.showPathForecast;
                const showWindField = isCycloneActive && state.showWindField;
                const showPressure = isCycloneActive && state.showPressureField;
                const showHumidity = isCycloneActive && state.showHumidityField;
                const siteDataToPass = state.currentSiteData;
    
                drawMap(mapSvg, mapProjection, state.world, state.cyclone, {
                    pathForecasts: forecasts,
                    pressureSystems: state.pressureSystems,
                    showPressureField: showPressure,
                    showHumidityField: showHumidity,
                    showPathForecast: showForecast,
                    showWindRadii: showRadii,
                    siteName: state.siteName,
                    siteLon: state.siteLon,
                    siteLat: state.siteLat,
                    showPathPoints: state.showPathPoints,
                    showWindField: showWindField,
                    month: state.currentMonth,
                    siteHistory: state.siteHistory,
                    siteData: siteDataToPass,
                    onSiteClick: onSiteClickCallback,
                    isPaused: state.isPaused,
                    // [新增] 删除回调
                    onSystemRemove: (systemData) => {
                        // 1. 确认是手动系统
                        if (!systemData.isManual) return;

                        // 2. 从 lower 和 upper 层中移除
                        // 我们通过 isManual 标记来查找，确保删干净
                        const removeManual = (list) => {
                            const idx = list.findIndex(s => s.isManual);
                            if (idx !== -1) list.splice(idx, 1);
                        };

                        if (state.pressureSystems.lower) removeManual(state.pressureSystems.lower);
                        if (state.pressureSystems.upper) removeManual(state.pressureSystems.upper);

                        playToggleOff(); // 播放删除音效
                        requestRedraw();
                    }
                });
            } else {
                const siteDataToPass = state.currentSiteData ? { 
                    ...state.currentSiteData, 
                    label: null 
                } : null;
                drawFinalPath(
                    mapSvg, mapProjection, state.cyclone, state.world, tooltip, 
                    state.siteName, state.siteLon, state.siteLat, 
                    state.showPathPoints, state.lastFinalStats, basinSelector.value, 
                    state.pressureSystems, state.showWindField,
                    // [新增] 传入站点相关参数
                    state.currentMonth, state.siteHistory, siteDataToPass, onSiteClickCallback
                );
            }
        }
    }

    function initMusicPlaylist() {
        if (!musicListContainer) return;
        musicListContainer.innerHTML = ''; // 清空现有内容

        musicTracks.forEach((filename, index) => {
            // 1. 提取显示名称 (移除 .mp4 后缀)
            const displayName = filename.replace(/\.mp4$/i, '').replace(/_/g, ' '); // 同时把下划线替换为空格，好看一点

            // 2. 创建列表项
            const li = document.createElement('li');
            li.className = "flex items-center justify-between px-3 py-2 rounded cursor-pointer transition-all border border-transparent hover:bg-white/5 hover:border-white/10 group";
            
            // 3. 内部 HTML 结构
            li.innerHTML = `
                <div class="flex items-center gap-2 overflow-hidden">
                    <i class="fa-solid fa-play text-[10px] text-slate-600 group-hover:text-cyan-400 transition-colors status-icon"></i>
                    <span class="text-xs font-mono text-slate-400 group-hover:text-white truncate transition-colors">${displayName}</span>
                </div>
                <div class="w-1.5 h-1.5 rounded-full bg-cyan-500 opacity-0 active-indicator shadow-[0_0_5px_cyan]"></div>
            `;

            // 4. 点击事件
            li.addEventListener('click', () => {
                playSelectedTrack(filename, index);
            });

            musicListContainer.appendChild(li);
        });
    }

    // [函数] 播放指定音轨
    function playSelectedTrack(filename, index) {
        // 如果点击的是当前正在播放的，且正在播放中，则暂停
        if (currentTrackIndex === index && !bgmAudio.paused) {
            bgmAudio.pause();
            updateMusicUI(index, false);
            return;
        }

        // 切换源并播放
        // 假设音乐文件在根目录或特定目录下，如果在 js 同级需调整路径，例如 `audio/${filename}`
        bgmAudio.src = filename; 
        bgmAudio.volume = bgmVolumeSlider ? bgmVolumeSlider.value : 0.4;
        
        bgmAudio.play().then(() => {
            currentTrackIndex = index;
            updateMusicUI(index, true);
        }).catch(err => {
            console.error("播放失败:", err);
        });
    }

    // [函数] 更新播放列表 UI 状态 (高亮当前项)
    function updateMusicUI(activeIndex, isPlaying) {
        const items = musicListContainer.querySelectorAll('li');
        
        items.forEach((item, idx) => {
            const icon = item.querySelector('.status-icon');
            const text = item.querySelector('span');
            const indicator = item.querySelector('.active-indicator');

            if (idx === activeIndex) {
                // 激活状态样式
                item.classList.add('bg-white/10', 'border-cyan-500/30');
                text.classList.replace('text-slate-400', 'text-cyan-400');
                indicator.classList.remove('opacity-0');
                
                if (isPlaying) {
                    icon.className = "fa-solid fa-pause text-[10px] text-cyan-400 status-icon";
                    // 主按钮高亮
                    musicButton.classList.add('text-cyan-400', 'border-cyan-500');
                } else {
                    icon.className = "fa-solid fa-play text-[10px] text-cyan-400 status-icon";
                    musicButton.classList.remove('text-cyan-400', 'border-cyan-500');
                }
            } else {
                // 重置其他项
                item.classList.remove('bg-white/10', 'border-cyan-500/30');
                text.classList.replace('text-cyan-400', 'text-slate-400');
                indicator.classList.add('opacity-0');
                icon.className = "fa-solid fa-play text-[10px] text-slate-600 group-hover:text-cyan-400 transition-colors status-icon";
            }
        });
    }

    // [初始化]
    initMusicPlaylist();

    // --- 事件监听器 ---
    generateButton.addEventListener('click', startSimulation);
    pauseButton.addEventListener('click', togglePause);

    downloadTrackButton.addEventListener('click', () => {
        const text = bestTrackData.value;
        if (!text) {
            alert("没有可用于命名的轨迹数据。");
            return;
        }

        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basin = basinMap[basinSelector.value] || 'WP';
        const year = new Date().getFullYear();
        const month = String(state.currentMonth).padStart(2, '0');
        const firstLine = text.split('\n')[0];
        const cycloneNum = firstLine ? firstLine.split(',')[1].trim() : '01';
        const filename = `map_${basin}${cycloneNum}_${year}${month}.png`;

        downloadMapImage('map-container', filename);
    });

    downloadHistoryTrackButton.addEventListener('click', downloadHistoryTrack);

    // [新增] 设置菜单事件监听器
    settingsButton.addEventListener('click', () => {
        playClick();
        settingsMenu.classList.toggle('hidden');
    });

    globalTempSlider.addEventListener('input', (e) => {
        state.GlobalTemp = parseInt(e.target.value, 10);
        globalTempValue.textContent = `${state.GlobalTemp}K`;
    });

    globalShearSlider.addEventListener('input', (e) => {
        state.GlobalShear = parseInt(e.target.value, 10);
        globalShearValue.textContent = `${state.GlobalShear}`;
    });

    historyButton.addEventListener('click', () => {
        playClick();
        historyList.innerHTML = '';
        if (state.history.length === 0) {
            historyList.innerHTML = '<li class="text-gray-400 p-2">尚无历史模拟记录。</li>';
        } else {
            [...state.history].reverse().forEach((item, index) => {
                const li = document.createElement('li');
                li.textContent = item.name; 
                li.className = 'text-white font-medium py-2 px-3 rounded-md cursor-pointer hover:bg-gray-700 transition-colors';
                li.dataset.historyIndex = state.history.length - 1 - index; 
                historyList.appendChild(li);
            });
        }
        historyModal.classList.remove('hidden');
        historyBestTrackContainer.classList.add('hidden'); // [新增] 默认隐藏ATCF显示区域
        state.selectedHistoryTrackData = ''; // [新增] 清空选中数据
    });

    closeHistoryModal.addEventListener('click', () => {
        historyModal.classList.add('hidden');
    });

    // 历史列表项点击事件
    historyList.addEventListener('click', (e) => {
        if (e.target && e.target.tagName === 'LI' && e.target.dataset.historyIndex) {
            const index = parseInt(e.target.dataset.historyIndex, 10);
            const historyItem = state.history[index];
            if (!historyItem) return;
            selectedHistoryPointIndex = -1;
            const selectedCyclone = historyItem.cycloneData;
            selectedCyclone.pressureHistory = historyItem.pressureHistory || [];
            selectedCyclone.siteHistory = historyItem.siteHistory || [];
            state.selectedHistoryCyclone = selectedCyclone;

            if (state.simulationInterval) {
                clearInterval(state.simulationInterval);
                state.simulationInterval = null;
            }
            state.isPaused = false;
            pauseButton.disabled = true;

            // historyModal.classList.add('hidden'); // 不关闭模态框，而是更新模态框内容
            document.getElementById('initial-message').classList.add('hidden');
            document.getElementById('simulation-output').classList.remove('hidden');
            bestTrackContainer.classList.add('hidden');
            
            drawFinalPath(mapSvg, mapProjection, selectedCyclone, state.world, tooltip, null, null, null, state.showPathPoints, null, basinSelector.value);
            forecastContainer.classList.remove('hidden');
            drawHistoricalIntensityChart(chartContainer, selectedCyclone.track, tooltip);

            let peak = { intensity: 0 };
            selectedCyclone.track.forEach(p => {
                if(p[2] > peak.intensity) {
                    peak = { lon: p[0], lat: p[1], intensity: p[2], isT: p[3], isE: p[4], circulationSize: p[5] || 300, isS: p[6], pressure: p[10] };
                }
            });
            const peakCat = getCategory(peak.intensity, peak.isT, peak.isE, peak.isS);
            
            document.getElementById('status').textContent = `查看历史: ${historyItem.name}`;
            document.getElementById('simulationTime').textContent = `总时长: ${selectedCyclone.age} 小时`;
            document.getElementById('latitude').textContent = `${peak.lat.toFixed(1)}°N`;
            document.getElementById('longitude').textContent = `${peak.lon.toFixed(1)}°E`;
            document.getElementById('intensity').textContent = `${knotsToKph(peak.intensity)} kph (${knotsToMph(peak.intensity)} mph)`;
            let displayP = peak.pressure;
            if (displayP === undefined || displayP === null) {
                const basin = selectedCyclone.basin || state.cyclone.basin || 'WPAC';
                displayP = Math.round(windToPressure(peak.intensity, peak.circulationSize, basin));
            }
            document.getElementById('pressure').textContent = `${displayP} hPa`;
            document.getElementById('category').textContent = peakCat.name;
            document.getElementById('ace').textContent = selectedCyclone.ace.toFixed(2);
            document.getElementById('direction').textContent = "N/A";
            document.getElementById('speed').textContent = "N/A";

            // [新增] 显示历史ATCF数据
            historyBestTrackData.value = historyItem.atcfData;
            historyBestTrackContainer.classList.remove('hidden');
            state.selectedHistoryTrackData = historyItem.atcfData; // [新增] 保存到state中，以便下载
        }
    });

    // [新增] 实测站点输入框事件监听器
    siteNameInput.addEventListener('input', (e) => {
        state.siteName = e.target.value;
        localStorage.setItem('tcs_site_name', state.siteName);
        requestRedraw();
    });
    siteLonInput.addEventListener('input', (e) => {
        const lon = parseFloat(e.target.value);
        state.siteLon = isNaN(lon) ? null : lon;
        localStorage.setItem('tcs_site_lon', e.target.value);
        requestRedraw();
    });
    siteLatInput.addEventListener('input', (e) => {
        const lat = parseFloat(e.target.value);
        state.siteLat = isNaN(lat) ? null : lat;
        localStorage.setItem('tcs_site_lat', e.target.value);
        requestRedraw();
    });

    const savedShowPoints = localStorage.getItem('tcs_show_points');

    if (showPathPointsCheckbox) {
        // A. 初始化状态
        if (savedShowPoints !== null) {
            // 有记录：覆盖 DOM 和 State
            const isChecked = savedShowPoints === 'true';
            showPathPointsCheckbox.checked = isChecked;
            state.showPathPoints = isChecked; 
        } else {
            // 无记录：同步 State
            state.showPathPoints = showPathPointsCheckbox.checked;
        }

        // B. 监听变更 (使用 'change' 事件更稳妥)
        showPathPointsCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            state.showPathPoints = isChecked; 
            localStorage.setItem('tcs_show_points', isChecked);
            
            if (typeof playClick === 'function') playClick();

            if (state.cyclone.status === 'active') {
                 requestRedraw();
            } else {
                 drawFinalPath(mapSvg, mapProjection, state.cyclone, state.world, tooltip, state.siteName, state.siteLon, state.siteLat, state.showPathPoints, state.lastFinalStats, basinSelector.value, state.pressureSystems, state.showWindField);
            } 
        });
    }

    // [新增] 自定义生成点事件监听器
    customLonInput.addEventListener('input', (e) => {
        const lon = parseFloat(e.target.value);
        if (!isNaN(lon)) {
            state.customLon = lon;
        } else {
            state.customLon = null;
        }
    });
    customLatInput.addEventListener('input', (e) => {
        const lat = parseFloat(e.target.value);
        if (!isNaN(lat)) {
            state.customLat = lat;
        } else {
            state.customLat = null;
        }
    });

    copyTrackButton.addEventListener('click', () => {
        bestTrackData.select();
        document.execCommand('copy');
        copyTrackButton.textContent = "已复制!";
    });

    // 在 DOMContentLoaded 内定义通用处理函数
    const toggleState = (key, btnId, callback) => {
        state[key] = !state[key];
        const btn = document.getElementById(btnId);
        updateToggleButtonVisual(btn, state[key]);
        if (state[key]) {
            playToggleOn();
        } else {
            playToggleOff();
        }
        if (callback) callback(state[key]); // 比如处理图例显示
        requestRedraw();
    };

    // 绑定事件时：
    document.getElementById('togglePressureButton').onclick = () => toggleState('showPressureField', 'togglePressureButton');
    document.getElementById('toggleHumidityButton').onclick = () => toggleState('showHumidityField', 'toggleHumidityButton');
    document.getElementById('toggleWindFieldButton').onclick = () => toggleState('showWindField', 'toggleWindFieldButton');
    document.getElementById('togglePathButton').onclick = () => toggleState('showPathForecast', 'togglePathButton');

    // 对于带图例的特殊处理 (Wind Radii)
    document.getElementById('toggleWindRadiiButton').onclick = () => toggleState('showWindRadii', 'toggleWindRadiiButton', (isShow) => {
        const legend = document.getElementById('wind-radii-legend');
        if (isShow) {
            legend.classList.remove('hidden');
            setTimeout(() => legend.setAttribute('data-show', 'true'), 10);
        } else {
            legend.setAttribute('data-show', 'false');
            setTimeout(() => legend.classList.add('hidden'), 300);
        }
    });

    musicButton.onclick = (e) => {
        e.stopPropagation();
        playClick(); // 播放音效
        
        // 切换菜单显示
        const isHidden = musicMenu.classList.contains('hidden');
        
        // 关闭其他菜单 (如 Settings) 以防重叠
        if (settingsMenu) settingsMenu.classList.add('hidden');
        
        if (isHidden) {
            musicMenu.classList.remove('hidden');
        } else {
            musicMenu.classList.add('hidden');
        }
    };

    // [事件监听] 点击外部关闭菜单
    document.addEventListener('click', (e) => {
        if (musicMenu && !musicMenu.contains(e.target) && !musicButton.contains(e.target)) {
            musicMenu.classList.add('hidden');
        }
    });

    // [事件监听] 音量滑块
    if (bgmVolumeSlider) {
        bgmVolumeSlider.addEventListener('input', (e) => {
            bgmAudio.volume = e.target.value;
        });
    }
    
    // [新增] 地图双击事件：生成手动高压
    mapContainer.on("dblclick", (event) => {
        // 1. 只有打开气压场时才允许操作
        if (!state.showPressureField) return;
        
        // 2. 获取鼠标位置的经纬度
        const [mouseX, mouseY] = d3.pointer(event);
        const coords = mapProjection.invert([mouseX, mouseY]);
        if (!coords) return;
        const [lon, lat] = coords;

        // 3. 检查是否已经存在手动高压 (限制最多 1 个)
        // 我们检查 lower 层即可
        const existingIndex = state.pressureSystems.lower.findIndex(s => s.isManual);

        if (existingIndex === -1) {
            // --- 生成新系统 ---
            const newSystem = {
                type: 'high',
                x: lon, 
                y: lat,
                sigmaX: 5,        // [要求] x=5 (大小)
                sigmaY: 3,        // [要求] y=3
                baseSigmaX: 5,    // 记录基准大小以便呼吸动画
                strength: 8,      // [要求] strength=8
                baseStrength: 8,
                velocityX: 0,     // 默认静止，可被 updatePressureSystems 推着走
                velocityY: 0,
                isManual: true,   // [标记] 这是手动生成的
                noiseLayers: []
            };

            // 同时推送到 upper 和 lower 层以符合双层架构
            const lowerSys = JSON.parse(JSON.stringify(newSystem));
            const upperSys = JSON.parse(JSON.stringify(newSystem));
            upperSys.strength = 8; // 上层稍微强一点

            state.pressureSystems.lower.push(lowerSys);
            state.pressureSystems.upper.push(upperSys);

            playClick(); // 播放音效
            requestRedraw();
        } else {
            // 如果已经存在一个，这里的逻辑是“再双击H按钮删除”，
            // 但如果用户双击地图空白处，是否要移动它？
            // 按照您的要求，这里什么都不做，或者您也可以选择移动它。
            // 暂且留空，严格遵守“双击H按钮删除”。
            console.log("Manual High already exists. Double click the 'H' marker to remove.");
        }
    });

    window.addEventListener('resize', () => {
        if (state.world) {
            setupCanvases();
             if (state.cyclone.status) {
                 updateStateSiteData();
                 drawMap(mapSvg, mapProjection, state.world, state.cyclone, {
                     pathForecasts: state.pathForecasts,
                     pressureSystems: state.pressureSystems,
                     showPressureField: state.showPressureField,
                     showHumidityField: state.showHumidityField,
                     showPathForecast: state.showPathForecast,
                     showWindRadii: state.showWindRadii,
                     siteName: state.siteName,
                     siteLon: state.siteLon,
                     siteLat: state.siteLat,
                     showPathPoints: state.showPathPoints,
                     showWindField: state.showWindField,
                     month: state.currentMonth,
                     siteHistory: state.siteHistory,
                     siteData: state.currentSiteData,
                     onSiteClick: () => {
                         state.isSiteSelected = !state.isSiteSelected;
                         requestRedraw();
                     }
                 });
             }
             if (state.cyclone.status && state.cyclone.status !== 'active') {
                 drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip);
             }
        }
    });

    window.addEventListener('cycloneTrackClick', (e) => {
        selectedHistoryPointIndex = e.detail.index;

        // 激活 JTWC 按钮
        generateJTWCButton.classList.remove('hidden');

        // 可选：给个按钮高亮动画
        generateJTWCButton.classList.add('ring-2', 'ring-red-500');
        setTimeout(() => generateJTWCButton.classList.remove('ring-2', 'ring-red-500'), 300);
    });

    mapContainer.node().addEventListener('click', (e) => {
        // 如果点击的是 SVG 背景或容器本身（而不是上面的 UI 按钮）
        if (e.target.tagName === 'svg' || e.target.id === 'map-container') {
            const jtwcActionButton = document.getElementById('jtwcActionButton');
            if (jtwcActionButton) jtwcActionButton.classList.add('hidden');
            selectedHistoryPointIndex = -1; // 确保你有这个变量的访问权限
        
            // 还要清除地图上的选中圆圈
            const interactionLayer = mapSvg.select(".track-interaction-layer");
            if (!interactionLayer.empty()) {
                interactionLayer.select(".selected-circle").style("opacity", 0);
            }
            requestRedraw();
        }
    });

    window.addEventListener('cycloneTrackDeselect', () => {
        if (generateJTWCButton) {
            generateJTWCButton.classList.add('hidden');
        }
    });

    // 绑定 JTWC 按钮点击事件
    generateJTWCButton.addEventListener('click', () => {
        console.log("JTWC Button Clicked");
        const targetCyclone = state.selectedHistoryCyclone || state.cyclone;
        
        let renderIndex = selectedHistoryPointIndex;
        if (renderIndex === -1) {
            if (targetCyclone && targetCyclone.track.length > 0) {
                renderIndex = targetCyclone.track.length - 1;
                if (!state.isPaused && state.simulationInterval && !state.selectedHistoryCyclone) {
                    togglePause(); 
                }
            } else {
                return;
            }
        }

        if (renderIndex === -1 || !targetCyclone) return;

        playClick();
        jtwcModal.classList.remove('hidden');
        
        // --- 1. 构建 Tab 界面结构 (增加 64KT 按钮) ---
        jtwcOutput.innerHTML = `
            <div class="flex h-[600px] w-full"> 
                <div class="w-40 flex-shrink-0 bg-gray-100 border-r border-gray-300 p-2 flex flex-col gap-2">
                    <div class="text-xs font-bold text-gray-500 mb-2 px-2">PRODUCTS</div>
                    
                    <button id="jtwc-tab-graphic" class="text-left px-3 py-2 text-sm font-bold bg-white border border-gray-300 rounded shadow-sm text-cyan-700 transition-all hover:bg-gray-50">
                        WARNING GRAPHIC
                    </button>
                    
                    <button id="jtwc-tab-prob34" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">
                        WIND PROB 34KT
                    </button>

                    <button id="jtwc-tab-prob64" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">
                        WIND PROB 64KT
                    </button>

                    <button id="jtwc-tab-phase" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">
                        PHASE SPACE
                    </button>

                    <div class="h-px bg-gray-300 my-1"></div>
                    <button id="jtwc-tab-station" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors flex items-center gap-2">
                        STATION OBS
                    </button>

                    <button id="jtwc-tab-synoptic" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors flex items-center gap-2">
                        SYNOPTIC CHART
                    </button>
                </div>
                
                <div id="jtwc-content-area" class="flex-1 bg-gray-50 flex items-center justify-center overflow-auto p-4 relative">
                    <div id="jtwc-loading" class="hidden absolute inset-0 flex items-center justify-center bg-white/80 z-10 text-cyan-600 font-bold pointer-events-none">
                        GENERATING...
                    </div>
                </div>
            </div>
        `;

        const contentArea = document.getElementById('jtwc-content-area');
        const tabGraphic = document.getElementById('jtwc-tab-graphic');
        const tabProb34 = document.getElementById('jtwc-tab-prob34');
        const tabProb64 = document.getElementById('jtwc-tab-prob64'); // 新增
        const tabStation = document.getElementById('jtwc-tab-station');
        const tabSynoptic = document.getElementById('jtwc-tab-synoptic');
        const loadingNode = document.getElementById('jtwc-loading');
        
        let currentCanvas = null;
        let currentMode = 'GRAPHIC'; // 用于保存文件名

        const showLoading = () => {
            contentArea.innerHTML = ''; 
            loadingNode.classList.remove('hidden'); 
            contentArea.appendChild(loadingNode); 
        };

        const updateTabStyles = (activeTab) => {
            [tabGraphic, tabProb34, tabProb64, tabStation, tabPhase, tabSynoptic].forEach(tab => {
                if (tab === activeTab) {
                    tab.className = "text-left px-3 py-2 text-sm font-bold bg-white border border-gray-300 rounded shadow-sm text-cyan-700 transition-all";
                } else {
                    tab.className = "text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors";
                }
            });
        };

        // --- 2. 定义渲染函数 ---
        
        const showGraphic = () => {
            updateTabStyles(tabGraphic);
            currentMode = 'GRAPHIC';
            showLoading(); 

            setTimeout(() => {
                const canvas = renderJTWCStyle(targetCyclone, renderIndex, state.world);
                canvas.className = "max-w-full max-h-full shadow-lg border border-gray-200"; 
                contentArea.innerHTML = ''; 
                contentArea.appendChild(canvas); 
                currentCanvas = canvas;
            }, 10);
        };

        // 通用概率图渲染函数
        const showProb = (threshold) => {
            const activeTab = threshold === 64 ? tabProb64 : tabProb34;
            updateTabStyles(activeTab);
            currentMode = threshold === 64 ? 'PROB64' : 'PROB34';
            
            showLoading();

            setTimeout(() => {
                if (typeof renderProbabilitiesStyle === 'function') {
                    // 传入 threshold 参数
                    const canvas = renderProbabilitiesStyle(targetCyclone, renderIndex, state.world, threshold);
                    canvas.className = "max-w-full max-h-full shadow-lg border border-gray-200";
                    contentArea.innerHTML = ''; 
                    contentArea.appendChild(canvas);
                    currentCanvas = canvas;
                } else {
                    contentArea.innerText = "Error: renderProbabilitiesStyle not imported.";
                }
            }, 50); 
        };

        // B. Phase Space 页面
        const showPhaseSpace = () => {
            updateTabStyles(tabPhase);
            currentMode = 'PHASE';
            currentCanvas = null;
            showLoading();

            setTimeout(() => {
                if (typeof renderPhaseSpace === 'function') {
                    const canvas = renderPhaseSpace(targetCyclone, state.GlobalTemp);
                    canvas.className = "max-w-full max-h-full shadow-lg border border-gray-800";
                    contentArea.innerHTML = '';
                    contentArea.appendChild(canvas);
                    currentCanvas = canvas;
                } else {
                    contentArea.innerText = "Module not loaded.";
                }
            }, 50);
        };

        const tabPhase = document.getElementById('jtwc-tab-phase');
        tabPhase.onclick = showPhaseSpace;

        const showSynopticChart = () => {
            updateTabStyles(tabSynoptic);
            currentMode = 'SYNOPTIC';
            currentCanvas = null;
            showLoading();

            // 1. 确定时间点
            const targetHour = renderIndex * 3;
            const isHistoryMode = !!state.selectedHistoryCyclone;
            
            let sourceSiteList = isHistoryMode ? (state.selectedHistoryCyclone.siteHistory || []) : state.siteHistory;
            const record = sourceSiteList.find(h => h.hour === targetHour);
            const sLon = record ? record.lon : state.siteLon;
            const sLat = record ? record.lat : state.siteLat;
            const sName = state.siteName || "STATION";

            let historySystem = null;
            
if (isHistoryMode) {
                // 历史模式：只读存档
                const pressureHistory = state.selectedHistoryCyclone.pressureHistory || [];
                // 精确查找
                const found = pressureHistory.find(h => h.age === targetHour);
                if (found) {
                    historySystem = { lower: found.lower, upper: found.upper };
                } else if (pressureHistory.length > 0) {
                    // 模糊查找 (fallback)
                    const closest = pressureHistory.reduce((prev, curr) => {
                        return (Math.abs(curr.age - targetHour) < Math.abs(prev.age - targetHour) ? curr : prev);
                    });
                    // 只接受误差在6小时内的
                    if (Math.abs(closest.age - targetHour) <= 6) {
                        historySystem = { lower: closest.lower, upper: closest.upper };
                    }
                }
            } else {
                // 实时模式：优先读全局 pressureHistory (模拟进行中)，或者直接读实时 pressureSystems (刚开始)
                if (state.pressureHistory && state.pressureHistory.length > 0) {
                    const found = state.pressureHistory.find(h => h.age === targetHour);
                    if (found) {
                        historySystem = { lower: found.lower, upper: found.upper };
                    }
                }
                
                // 兜底：如果还没生成历史 (Time=0)，直接用当前实时系统
                if (!historySystem) {
                    historySystem = state.pressureSystems;
                }
            }

            // 渲染检查
            if (!historySystem) {
                contentArea.innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 font-bold">NO SYNOPTIC DATA FOUND</div>';
                return;
            }

            setTimeout(() => {
                if (typeof renderStationSynopticChart === 'function') {
                    const canvas = renderStationSynopticChart(
                        targetCyclone, 
                        renderIndex, 
                        state.world, 
                        historySystem,
                        sLon, sLat, sName
                    );
                    canvas.className = "max-w-full max-h-full shadow-lg border border-gray-800";
                    contentArea.innerHTML = '';
                    contentArea.appendChild(canvas);
                    currentCanvas = canvas;
                } else {
                    contentArea.innerText = "Module renderStationSynopticChart not loaded.";
                }
            }, 50);
        };

        // 绑定事件
        tabSynoptic.onclick = showSynopticChart;

        // C. [修复版] 站点数据视图：基于历史记录查表
        const showStationData = () => {
            updateTabStyles(tabStation);
            currentMode = 'STATION';
            currentCanvas = null;
            contentArea.innerHTML = ''; 

            // 1. 计算目标时间
            // renderIndex 是轨迹点的索引，每步3小时
            const targetHour = renderIndex * 3;
            const isHistoryMode = !!state.selectedHistoryCyclone;
            let sourceList = [];
            if (isHistoryMode) {
                sourceList = state.selectedHistoryCyclone.siteHistory || [];
            } else {
                sourceList = state.siteHistory || [];
            }

            // 在确定的列表里查找记录
            const record = sourceList.find(h => h.hour === targetHour);

            // 3. 错误处理：如果没有记录（例如模拟未开始、未设置站点、或改了站点导致历史失效）
            if (!record) {
                contentArea.innerHTML = `
                    <div class="text-center text-slate-500 mt-20">
                        <i class="fa-solid fa-file-circle-xmark text-4xl mb-4 text-slate-300"></i>
                        <p class="font-bold">NO DATA RECORDED</p>
                        <p class="text-xs mt-2">No station measurements found for T+${targetHour}H.</p>
                        <p class="text-[10px] text-slate-400 mt-1">(Station monitoring might have been disabled)</p>
                    </div>
                `;
                return;
            }

            // 4. 解析记录的数据 (不再进行物理计算)
            const localWindKt = Math.round(record.wind);
            const localPressure = Math.round(record.pressure);
            
            // 恢复风向
            const flowAngleMath = Math.atan2(-record.v, record.u) * (180 / Math.PI);
            let windFromDir = (flowAngleMath + 270) % 360; 
            if (windFromDir < 0) windFromDir += 360;
            const localWindDirStr = directionToCompass(windFromDir);

            // 恢复天气状况 (基于 dBZ)
            const dbz = record.dbz || 0;
            let conditionText = "FAIR";
            let conditionClass = "text-slate-500";
            let iconClass = "fa-sun";

            if (dbz >= 50) { conditionText = "VIOLENT STORM"; conditionClass = "text-purple-600"; iconClass = "fa-cloud-bolt"; }
            else if (dbz >= 35) { conditionText = "HEAVY RAIN"; conditionClass = "text-blue-700"; iconClass = "fa-cloud-showers-heavy"; }
            else if (dbz >= 15) { conditionText = "MODERATE RAIN"; conditionClass = "text-blue-500"; iconClass = "fa-cloud-rain"; }
            else if (dbz >= 5) { conditionText = "OVERCAST"; conditionClass = "text-slate-600"; iconClass = "fa-cloud"; }

            // 计算气旋距离 (使用当时气旋的位置 vs 当时站点的位置)
            // 注意：targetCyclone.track[renderIndex] 是气旋当时的位置
            const p = targetCyclone.track[renderIndex];
            // record.lat/lon 是当时站点的位置 (如果按照上面的修改存了的话，否则用当前的 state.siteLat)
            const siteLatFixed = record.lat || state.siteLat;
            const siteLonFixed = record.lon || state.siteLon;
            
            const distKm = calculateDistance(p[1], p[0], siteLatFixed, siteLonFixed);
            const bearing = (Math.atan2(p[0] - siteLonFixed, p[1] - siteLatFixed) * 180 / Math.PI + 360) % 360;
            const dirCompass = directionToCompass(bearing);
            const bearingRad = Math.atan2(p[0] - siteLonFixed, p[1] - siteLatFixed);
            let bearingDeg = (bearingRad * 180 / Math.PI);
            if (bearingDeg < 0) bearingDeg += 360;
            const bearingStr = directionToCompass(bearingDeg);

            // 5. 渲染 HTML (保持原有样式)
            const siteName = state.siteName || "UNNAMED STATION";
            const year = new Date().getFullYear();
            const monthIndex = (state.currentMonth || 8) - 1; 
            const simDate = new Date(Date.UTC(year, monthIndex, 1)); // 从当月1号开始
            simDate.setUTCHours(simDate.getUTCHours() + targetHour); // 加上累计小时数
            
            const dd = String(simDate.getUTCDate()).padStart(2, '0');
            const hh = String(simDate.getUTCHours()).padStart(2, '0');
            const validTimeStr = `${dd}/${hh}Z`; // 例如: 05/12Z

contentArea.innerHTML = `
                <div class="bg-white p-6 shadow-sm border border-gray-200 w-full max-w-2xl font-mono h-full flex flex-col">
                    <div class="flex justify-between items-end mb-4 border-b pb-2">
                        <div>
                            <div class="text-[10px] text-gray-400 font-bold">STATION OBS</div>
                            <div class="text-2xl font-black">${siteName.toUpperCase()}</div>
                            <div class="text-[10px] text-gray-500 mt-1 flex gap-2">
                                <span><i class="fa-solid fa-location-dot"></i> ${siteLatFixed.toFixed(2)}N, ${siteLonFixed.toFixed(2)}E</span>
                                <span><i class="fa-solid fa-clock"></i> T+${targetHour}H</span>
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-3xl font-black text-cyan-700">${validTimeStr}</div>
                            <div class="text-xs text-gray-400 font-bold">VALID TIME</div>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4 mb-4">
                        <div id="panel-wind" class="bg-slate-50 p-3 border-2 border-transparent hover:border-cyan-400 cursor-pointer transition-all group relative">
                            <div class="text-[10px] text-slate-400 font-bold mb-1 group-hover:text-cyan-600">WIND (CLICK FOR CHART)</div>
                            <div class="flex items-baseline gap-2">
                                <div class="text-4xl font-black text-slate-800">${localWindKt}</div>
                                <div class="text-sm font-bold text-slate-500">KT</div>
                            </div>
                            <div class="text-xs font-bold text-slate-600 mt-1 flex items-center gap-1">
                                <i class="fa-solid fa-location-arrow transform rotate-[${windFromDir + 135}deg]"></i> 
                                ${localWindDirStr} <span class="text-[10px] text-slate-400 font-normal">(${Math.round(windFromDir)}°)</span>
                            </div>
                            <i class="fa-solid fa-chart-line absolute top-2 right-2 text-slate-200 group-hover:text-cyan-400"></i>
                        </div>

                        <div id="panel-pressure" class="bg-slate-50 p-3 border-2 border-transparent hover:border-yellow-400 cursor-pointer transition-all group relative">
                            <div class="text-[10px] text-slate-400 font-bold mb-1 group-hover:text-yellow-600">MSLP (CLICK FOR CHART)</div>
                            <div class="flex items-baseline gap-2">
                                <div class="text-4xl font-black text-slate-800">${localPressure}</div>
                                <div class="text-sm font-bold text-slate-500">hPa</div>
                            </div>
                            <div class="text-xs text-slate-400 mt-1">RECORDED</div>
                            <i class="fa-solid fa-chart-line absolute top-2 right-2 text-slate-200 group-hover:text-yellow-400"></i>
                        </div>
                    </div>

                    <div class="grid grid-cols-3 gap-2 text-center mb-4">
                        <div class="border p-2 rounded"><div class="text-[10px] text-gray-400">DIST</div><div class="font-bold">${Math.round(distKm)} KM</div></div>
                        <div class="border p-2 rounded"><div class="text-[10px] text-gray-400">COND</div><div class="font-bold ${conditionClass}"><i class="fa-solid ${iconClass}"></i> ${conditionText}</div></div>
                        <div class="border p-2 rounded">
                            <div class="text-[10px] text-gray-400">STORM BEARING</div>
                            <div class="font-bold text-[10px]">${bearingStr} (${Math.round(bearingDeg)}°)</div>
                        </div>
                    </div>

                    <div class="flex-1 border border-slate-100 bg-slate-50 rounded relative overflow-hidden">
                        <div id="station-chart-title" class="absolute top-2 left-2 text-[10px] font-bold text-slate-400 z-10">SELECT A PARAMETER ABOVE</div>
                        <div id="station-chart-view" class="w-full h-full"></div>
                    </div>
                </div>
            `;

            // 绑定点击事件
            const chartContainer = "#station-chart-view";
            const titleLabel = document.getElementById('station-chart-title');
            const panelWind = document.getElementById('panel-wind');
            const panelPressure = document.getElementById('panel-pressure');
            const historySlice = sourceList.filter(h => h.hour <= targetHour);

            // 默认显示 Wind
            drawStationGraph(chartContainer, historySlice, 'wind');
            titleLabel.textContent = "PAST WIND SPEED HISTORY";
            panelWind.classList.add('border-cyan-400', 'bg-cyan-50');

            panelWind.onclick = () => {
                drawStationGraph(chartContainer, historySlice, 'wind');
                titleLabel.textContent = "WIND SPEED HISTORY";
                // 更新高亮状态
                panelWind.classList.add('border-cyan-400', 'bg-cyan-50');
                panelPressure.classList.remove('border-yellow-400', 'bg-yellow-50');
            };

            panelPressure.onclick = () => {
                drawStationGraph(chartContainer, historySlice, 'pressure');
                titleLabel.textContent = "MSLP HISTORY";
                // 更新高亮状态
                panelPressure.classList.add('border-yellow-400', 'bg-yellow-50');
                panelWind.classList.remove('border-cyan-400', 'bg-cyan-50');
            };
        };

        // --- 3. 绑定事件 ---
        tabGraphic.onclick = showGraphic;
        tabProb34.onclick = () => showProb(34);
        tabProb64.onclick = () => showProb(64);
        tabStation.onclick = showStationData;

        const saveBtn = document.getElementById('saveJtwcImage');
        saveBtn.onclick = () => {
            if (currentCanvas) {
                const link = document.createElement('a');
                const name = targetCyclone.name || 'STORM';
                // 使用 currentMode 来区分文件名
                link.download = `JTWC_${name}_${currentMode}_T${renderIndex * 3}.png`;
                link.href = currentCanvas.toDataURL();
                link.click();
            } else {
                alert("没有可保存的图像。");
            }
        };

        showGraphic();
    });

    closeJtwcModal.addEventListener('click', () => jtwcModal.classList.add('hidden'));
    
    if (catButton && newsModal) {
        catButton.addEventListener('click', () => {
            if (!state.cyclone || !state.cyclone.track || state.cyclone.track.length < 2) {
                alert("需要先运行模拟生成路径。");
                return;
            }

            if (typeof playClick === 'function') playClick();
        
            // 1. 显示模态框
            newsModal.classList.remove('hidden');

            // 2. 设置滚动新闻内容
            const ticker = document.getElementById('newsTicker');
            const name = (state.cyclone.name || "UNNAMED").toUpperCase();
            const catName = getEnglishCategoryName(
                state.cyclone.intensity, 
                state.cyclone.isExtratropical, 
                state.cyclone.isSubtropical,
                basinSelector.value
            );
            const wind = Math.round(state.cyclone.intensity);
            const pressure = Math.round(windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, basinSelector.value));

            let landfallAlert = "";
            
            // 检查是否有预测路径
            if (state.pathForecasts && state.pathForecasts.length > 0) {
                // 取第一条模型 (通常是共识或GFS)
                const forecastTrack = state.pathForecasts[0].track;
                let willLandfall = false;

                // 遍历预测点 (每点通常间隔6-12小时，覆盖未来72小时+)
                for (let i = 0; i < forecastTrack.length; i++) {
                    const p = forecastTrack[i];
                    // p[0] = lon, p[1] = lat
                    // 使用 terrain-data.js 里的 getLandStatus 检测
                    if (getLandStatus(p[0], p[1]) === 'land') {
                        willLandfall = true;
                        break; // 只要有一点碰到陆地，就触发警报
                    }
                }

                if (willLandfall) {
                    landfallAlert = "AND FORECAST INDICATES LANDFALL IMMINENT IN THE NEXT 72 HOURS.";
                }
            }
        
            // 构建新闻字符串 (重复几次以填满屏幕)
            const newsItem = `UPDATED: ${catName} "${name}" LOCATED AT ${state.cyclone.lat.toFixed(1)}N ${state.cyclone.lon.toFixed(1)}E, MAX WINDS: ${Math.round(wind/5)*5} KT, MIN PRESSURE: ${pressure} HPA. ${landfallAlert}`;
            ticker.textContent = newsItem;

            // 3. 启动 Canvas 动画
            if (stopNewsAnimation) stopNewsAnimation(); // 清理旧的
            stopNewsAnimation = startNewsAnimation(
                newsCanvas, 
                state.world, 
                state.cyclone, 
                state.pathForecasts, 
                basinSelector.value,
                state.simulationCount,
                state.pressureSystems,
                state.currentMonth,
                state.GlobalTemp,
                state.GlobalShear
            );
        });

        const closeNews = () => {
            newsModal.classList.add('hidden');
            if (stopNewsAnimation) {
                stopNewsAnimation(); // 停止动画循环，节省性能
                stopNewsAnimation = null;
            }
        };

        closeNewsModal.addEventListener('click', closeNews);
    
        // 点击背景关闭
        newsModal.addEventListener('click', (e) => {
            if (e.target === newsModal) closeNews();
        });
    }

    document.addEventListener('keydown', (event) => {
        // [关键] 如果焦点在输入框或文本域内，不触发快捷键，防止打字冲突
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }

        // Space: 暂停/继续
        if (event.code === 'Space') {
            event.preventDefault(); // 防止滚动页面
            togglePause();
        }

        // S: 开始 / 重启 (相当于点击 Generate 按钮)
        if (event.code === 'KeyS') {
            // 使用 click() 模拟点击，这样能同时触发音效、UI更新和模拟逻辑
            generateButton.click();
        }

        if (event.code === 'KeyR') {
            // [修改] 如果正在显示多普勒，则关闭多普勒，切换到基本反射率
            const radarLegend = document.getElementById('radar-legend');
            const dopplerLegend = document.getElementById('doppler-legend');

            if (state.dopplerMode) {
                state.dopplerMode = false;
                state.radarMode = true;
            } else {
                // 原有逻辑：切换基本反射率
                state.radarMode = !state.radarMode;
            }
            
            if (state.radarMode) {
                // 如果开启雷达，显示雷达图例
                if (radarLegend) {
                    radarLegend.classList.remove('hidden');
                    // 延时以触发 CSS transition 动画
                    setTimeout(() => {
                        radarLegend.setAttribute('data-show', 'true');
                    }, 10);
                }
                // 隐藏多普勒图例
                if (dopplerLegend) {
                    dopplerLegend.setAttribute('data-show', 'false');
                    setTimeout(() => {
                        dopplerLegend.classList.add('hidden');
                    }, 300); // 等待动画结束
                }
            } else {
                // 如果关闭雷达，隐藏雷达图例
                if (radarLegend) {
                    radarLegend.setAttribute('data-show', 'false');
                    setTimeout(() => {
                        radarLegend.classList.add('hidden');
                    }, 300); // 等待动画结束
                }
                if (dopplerLegend) {
                    dopplerLegend.setAttribute('data-show', 'false');
                    setTimeout(() => {
                        dopplerLegend.classList.add('hidden');
                    }, 300); // 等待动画结束
                }
            }
            // Optional: Play a sound
            // playToggleOn(); 
            
            // Trigger redraw
            requestRedraw();
           
            // Visual feedback (Toast or Console)
            console.log(`Radar Mode: ${state.radarMode ? 'ON' : 'OFF'}`);
        }

        // [新增] 'D' 键切换多普勒雷达
        if (event.code === 'KeyD') {
            const radarLegend = document.getElementById('radar-legend');
            const dopplerLegend = document.getElementById('doppler-legend');

            // 如果正在显示基本反射率，则关闭它，切换到多普勒
            if (state.radarMode) {
                state.radarMode = false;
                state.dopplerMode = true;
            } else {
                state.dopplerMode = !state.dopplerMode;
            }
            
            // 多普勒模式下，我们暂时隐藏基本反射率的图例 (颜色含义不同)
            if (state.dopplerMode) {
                if (dopplerLegend) {
                    dopplerLegend.classList.remove('hidden');
                    setTimeout(() => {
                        dopplerLegend.setAttribute('data-show', 'true');
                    }, 10);
                }
                if (radarLegend) {
                    radarLegend.setAttribute('data-show', 'false');
                    setTimeout(() => {
                        radarLegend.classList.add('hidden');
                    }, 300);
                }
                console.log(`Doppler Mode: ON`);
            } else {
                 if (dopplerLegend) {
                    dopplerLegend.setAttribute('data-show', 'false');
                    setTimeout(() => {
                        dopplerLegend.classList.add('hidden');
                    }, 300);
                }
                console.log(`Doppler Mode: OFF`);
            }
            
            requestRedraw();
        }
        // 1, 2, 3: 切换模拟速度 (如果你之前添加了这部分代码，请保留)
        if (event.key === '1') changeSimulationSpeed(50);
        if (event.key === '2') changeSimulationSpeed(200);
        if (event.key === '3') changeSimulationSpeed(600);

        if (event.code === 'KeyV') {
            toggleLeftPanel();
        }
    });

    tabKt.addEventListener('click', () => {
        chartMode = 'kt';
        updateTabUI();
        if (state.cyclone && state.cyclone.track) {
            drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip, 'kt', basinSelector.value);
        }
    });

    tabHpa.addEventListener('click', () => {
        chartMode = 'hpa';
        updateTabUI();
        if (state.cyclone && state.cyclone.track) {
            drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip, 'hpa', basinSelector.value);
        }
    });

    // 打开帮助面板
    helpButton.addEventListener('click', () => {
        playClick();
        helpModal.classList.remove('hidden');
        // 微小的延时以触发 CSS transition
        setTimeout(() => {
            helpModal.classList.remove('opacity-0');
            helpModal.querySelector('div').classList.remove('scale-95');
            helpModal.querySelector('div').classList.add('scale-100');
        }, 10);
    });

    // 关闭帮助面板
    function hideHelp() {
        helpModal.classList.add('opacity-0');
        helpModal.querySelector('div').classList.add('scale-95');
        helpModal.querySelector('div').classList.remove('scale-100');
        setTimeout(() => {
            helpModal.classList.add('hidden');
        }, 300);
    }

    closeHelpModal.addEventListener('click', () => {
        playClick(); // 可选：关闭音效
        hideHelp();
    });

    sfxButton.addEventListener('click', () => {
        const isMuted = toggleSFX();
    
        // 更新 UI 状态
        if (isMuted) {
            sfxIcon.classList.remove('fa-volume-high');
            sfxIcon.classList.add('fa-volume-xmark');
            sfxButton.classList.replace('text-cyan-400', 'text-slate-500');
        } else {
            sfxIcon.classList.remove('fa-volume-xmark');
            sfxIcon.classList.add('fa-volume-high');
            sfxButton.classList.replace('text-slate-500', 'text-cyan-400');
        }
    
        // 触发一个简短的点击音效（如果此时已开启）以反馈
        if (typeof playClick === 'function') playClick();
    });

    // 点击背景关闭
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) {
            hideHelp();
        }
    });
});