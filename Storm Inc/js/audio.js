/**
 * js/audio.js
 * 基于 Web Audio API 的实时音效库
 * 包含：初始化、音频分析器连接、噪声生成及各类 UI 音效
 */

let audioCtx = null;
let masterGain = null;
let analyser = null; // 音频分析器 (用于视觉化)
let noiseBuffer = null; // 白噪声缓存
let isSFXMuted = false;

export function toggleSFX() {
    isSFXMuted = !isSFXMuted;
    return isSFXMuted;
}

// 初始化音频上下文
export function initAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        
        // --- 视觉化核心：创建分析器 ---
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048; // 精度
        
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.2; // 主音量
        
        // 连接链：Master -> Analyser -> Speaker
        masterGain.connect(analyser);
        analyser.connect(audioCtx.destination);
        
        // 生成白噪声 Buffer (用于 playClick 等音效)
        const bufferSize = audioCtx.sampleRate * 2;
        noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
    }
    
    // 处理浏览器挂起状态
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playTone(freq, startTime, duration, type = 'sine') {
    if (!audioCtx || isSFXMuted) return;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = type;
    osc.frequency.value = freq;

    // 包络设置 (ADSR): 快速起音，中等衰减，模拟敲击乐/钟声
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.02); // Attack
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration); // Decay

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration);
}

// ... (保留 playClick, playAlert 等其他函数) ...

// [新增] 台风升级音效: 4音符，C大调大七和弦 (C-E-G-B)，播放两次
export function playUpgradeSound() {
    if (isSFXMuted) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    
    const now = audioCtx.currentTime;
    
    // 音符频率表 (C5, E5, G5, B5) -> 听起来非常明亮、开心
    const notes = [523.25, 659.25, 783.99, 1047.77]; 
    
    // 节奏设置
    const noteLen = 0.12; // 每个音符的间隔
    const repeatDelay = 0.9; // 重复时的停顿间隔

    // 第一遍: 噔-噔-噔-噔 (C-E-G-B)
    notes.forEach((freq, i) => {
        // 使用 'triangle' (三角波) 会比正弦波更像 8-bit 游戏机或电子提示音，听起来更悦耳
        // 也可以混合使用，这里用 sine 叠加一点泛音感觉会更纯净，我们直接用 triangle 增加一点厚度
        playTone(freq, now + i * noteLen, 0.4, 'triangle');
        
        // 叠加一个高八度的正弦波，增加“水晶”质感
        playTone(freq * 2, now + i * noteLen, 0.3, 'sine'); 
    });

    // 第二遍: 噔-噔-噔-噔 (重复)
    notes.forEach((freq, i) => {
        const startTime = now + repeatDelay + i * noteLen;
        playTone(freq, startTime, 0.4, 'triangle');
        playTone(freq * 2, startTime, 0.3, 'sine');
    });
}

export function playCat5Sound() {
    if (isSFXMuted) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    
    // 5个音符 (C5, E5, G5, B5, D6) - C Major 9
    const notes = [523.25, 659.25, 783.99, 987.77, 1174.66]; 
    const noteLen = 0.08; // 单个音符的间隔
    const repeatDelay = 0.9; // [新增] 第二次播放的延迟时间

    // 定义单次琶音的播放逻辑
    const playArpeggio = (startTime) => {
        notes.forEach((freq, i) => {
            const time = startTime + i * noteLen;
            
            // 层1: 主音 (Triangle Wave) - 敲击感
            const osc1 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            osc1.type = 'triangle';
            osc1.frequency.value = freq;
            
            gain1.gain.setValueAtTime(0, time);
            gain1.gain.linearRampToValueAtTime(0.2, time + 0.02); 
            gain1.gain.exponentialRampToValueAtTime(0.001, time + 0.6); 
            
            osc1.connect(gain1);
            gain1.connect(audioCtx.destination);
            osc1.start(time);
            osc1.stop(time + 0.6);

            // 层2: 泛音 (Sine Wave) - 水晶拖尾
            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.type = 'sine';
            osc2.frequency.value = freq * 2; // 高八度
            
            gain2.gain.setValueAtTime(0, time);
            gain2.gain.linearRampToValueAtTime(0.15, time + 0.05); 
            gain2.gain.exponentialRampToValueAtTime(0.001, time + 2.5); // 2.5秒长拖尾
            
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.start(time);
            osc2.stop(time + 2.5);
        });
    };

    // 播放第一遍
    playArpeggio(now);

    // 播放第二遍 (间隔 0.9秒)
    playArpeggio(now + repeatDelay);
}

/**
 * 获取分析器节点 (用于在 HTML 页面中绘制 Canvas)
 */
export function getAnalyser() {
    return analyser;
}

/**
 * 内部辅助：创建带有 Detune 的振荡器
 */
function createOscillatorNode(type, freq, startTime, duration, detune = 0) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    osc.detune.value = detune;

    osc.connect(gain);
    return { osc, gain };
}

// --- 音效定义 ---

// 1. 点击音效 (Pitch Drop - 气泡/木鱼感)
export function playClick() {
    initAudio();
    if (isSFXMuted) return;
    const t = audioCtx.currentTime;
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine'; // 使用正弦波，最圆润

    // 关键技巧：快速的音高下降 (Pitch Drop)
    // 从 800Hz 快速掉到 300Hz
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.1);

    // 音量包络：极短的起音，快速衰减
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.5, t + 0.01); // 10ms 起音，防止爆音
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(t);
    osc.stop(t + 0.1);
}

// 2. 开启开关 (双振荡器 Detune - 科技感)
export function playToggleOn() {
    initAudio();
    if (isSFXMuted) return;
    const t = audioCtx.currentTime;
    const duration = 0.15;

    [0, 15].forEach(detuneAmount => {
        const { osc, gain } = createOscillatorNode('triangle', 400, t, duration, detuneAmount);
        
        osc.frequency.exponentialRampToValueAtTime(800, t + duration);
        
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.linearRampToValueAtTime(0, t + duration);
        
        gain.connect(masterGain);
        osc.start(t);
        osc.stop(t + duration);
    });
}

// 3. 关闭开关 (Sawtooth + Lowpass Filter - 柔和关闭)
export function playToggleOff() {
    initAudio();
    if (isSFXMuted) return;
    const t = audioCtx.currentTime;
    const duration = 0.15;
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    
    osc.type = 'sawtooth';
    osc.frequency.value = 150;
    
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, t);
    filter.frequency.exponentialRampToValueAtTime(100, t + duration);
    
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.linearRampToValueAtTime(0, t + duration);
    
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    
    osc.start(t);
    osc.stop(t + duration);
}

// 4. 游戏开始/模拟启动 (快速琶音)
export function playStart() {
    initAudio();
    if (isSFXMuted) return;
    const t = audioCtx.currentTime;
    
    // 你自定义的音符序列
    // 523.25(C5), 659.25(E5), 783.99(G5), 646.50(近似 E5)
    const notes = [523.25, 659.25, 783.99, 646.50];
    
    notes.forEach((freq, i) => {
        // 每个音符非常短，且紧凑播放
        const startTime = t + (i * 0.05); // 间隔仅 50ms
        const duration = 0.4; // 余音较短

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        // 使用三角波 (Triangle)
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, startTime);

        // 音量包络
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

        osc.connect(gain);
        gain.connect(masterGain);

        osc.start(startTime);
        osc.stop(startTime + duration);
    });
}

// 5. 错误/警告 (FM Synthesis - 金属杂音)
export function playError() {
    initAudio();
    if (isSFXMuted) return;
    const t = audioCtx.currentTime;
    const duration = 0.3;
    
    const carrier = audioCtx.createOscillator();
    const carrierGain = audioCtx.createGain();
    const modulator = audioCtx.createOscillator();
    const modulatorGain = audioCtx.createGain();
    
    carrier.type = 'sine';
    carrier.frequency.value = 200;
    
    modulator.type = 'square';
    modulator.frequency.value = 50; 
    modulatorGain.gain.value = 800; // 调制深度
    
    modulator.connect(modulatorGain);
    modulatorGain.connect(carrier.frequency);
    
    carrier.connect(carrierGain);
    carrierGain.connect(masterGain);
    
    carrierGain.gain.setValueAtTime(0.5, t);
    carrierGain.gain.exponentialRampToValueAtTime(0.01, t + duration);
    
    carrier.start(t);
    modulator.start(t);
    carrier.stop(t + duration);
    modulator.stop(t + duration);
}

// 6. 警报 (Delay/Echo - 空间感)
export function playAlert() {
    initAudio();
    if (isSFXMuted) return;
    const now = audioCtx.currentTime;
    
    const delay = audioCtx.createDelay();
    delay.delayTime.value = 0.15;
    
    const feedback = audioCtx.createGain();
    feedback.gain.value = 0.4;
    
    const delayFilter = audioCtx.createBiquadFilter();
    delayFilter.frequency.value = 1000;
    
    delay.connect(feedback);
    feedback.connect(delayFilter);
    delayFilter.connect(delay); // 形成环路
    delay.connect(masterGain);
    
    const notes = [880, 1108, 1318];
    notes.forEach((freq, i) => {
        const t = now + (i * 0.1);
        const osc = audioCtx.createOscillator();
        const env = audioCtx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        
        env.gain.setValueAtTime(0.3, t);
        env.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        
        osc.connect(env);
        env.connect(masterGain);
        env.connect(delay);
        
        osc.start(t);
        osc.stop(t + 1.3);
    });
}