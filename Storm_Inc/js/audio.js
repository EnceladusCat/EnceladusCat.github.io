/**
 * js/audio.js
 */

let audioCtx = null;
let masterGain = null;
let analyser = null;
let noiseBuffer = null;
let isSFXMuted = false;

// Reverb impulse response for adding depth
let reverbBuffer = null;
let reverbNode = null;

export function toggleSFX() {
    isSFXMuted = !isSFXMuted;
    return isSFXMuted;
}

// Create a simple reverb impulse response
function createReverbBuffer() {
    const sampleRate = audioCtx.sampleRate;
    const length = sampleRate * 1.5; // 1.5 second reverb
    const impulse = audioCtx.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
        const channelData = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            // Exponentially decaying noise
            channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        }
    }
    
    return impulse;
}

// Initialize audio context
export function initAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        
        // Create analyser for visualization
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        
        // Create reverb
        reverbBuffer = createReverbBuffer();
        reverbNode = audioCtx.createConvolver();
        reverbNode.buffer = reverbBuffer;
        
        const reverbGain = audioCtx.createGain();
        reverbGain.gain.value = 0.15; // Subtle reverb
        
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.25; // Slightly higher master volume
        
        // Connection chain: Master -> Reverb -> Analyser -> Speaker
        masterGain.connect(analyser);
        masterGain.connect(reverbGain);
        reverbGain.connect(reverbNode);
        reverbNode.connect(analyser);
        analyser.connect(audioCtx.destination);
        
        // Generate white noise buffer
        const bufferSize = audioCtx.sampleRate * 2;
        noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
    }
    
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

/**
 * Helper: Create a smooth oscillator with proper envelope and filtering
 */
function createSmoothTone(freq, startTime, duration, type = 'sine', options = {}) {
    if (!audioCtx || isSFXMuted) return null;
    
    const {
        attack = 0.02,
        release = 0.1,
        peakGain = 0.3,
        filterFreq = null, // Lowpass filter frequency
        detune = 0
    } = options;
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    
    // Smooth envelope (prevents clicks)
    const attackTime = startTime + attack;
    const releaseStart = startTime + duration - release;
    
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(peakGain, attackTime);
    gainNode.gain.setValueAtTime(peakGain, releaseStart);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    
    osc.connect(gainNode);
    
    // Optional lowpass filter for warmth
    if (filterFreq) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = filterFreq;
        filter.Q.value = 1;
        gainNode.connect(filter);
        
        osc.start(startTime);
        osc.stop(startTime + duration);
        
        return { osc, gain: gainNode, filter };
    }
    
    osc.start(startTime);
    osc.stop(startTime + duration);
    
    return { osc, gain: gainNode };
}

// --- IMPROVED SOUND EFFECTS ---

/**
 * 1. Click sound - Soft, pleasant bubble-like tone
 */
export function playClick() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    const duration = 0.15;
    
    // Two layered oscillators for richness
    const fundamental = createSmoothTone(520, t, duration, 'sine', {
        attack: 0.005,
        release: 0.08,
        peakGain: 0.2,
        filterFreq: 2000
    });
    
    const harmonic = createSmoothTone(780, t, duration * 0.6, 'sine', {
        attack: 0.01,
        release: 0.05,
        peakGain: 0.1
    });
    
    if (fundamental) fundamental.gain.connect(masterGain);
    if (harmonic) harmonic.gain.connect(masterGain);
}

/**
 * 2. Toggle On - Rising, cheerful sound
 */
export function playToggleOn() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    const duration = 0.2;
    
    // Create two detuned oscillators for warmth
    [0, 8].forEach((detuneAmount, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const filter = audioCtx.createBiquadFilter();
        
        osc.type = 'sine';
        osc.detune.value = detuneAmount;
        
        // Rising pitch (300Hz -> 600Hz)
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(600, t + duration);
        
        // Lowpass filter for smoothness
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1200, t);
        filter.frequency.exponentialRampToValueAtTime(2400, t + duration);
        
        // Smooth envelope
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(masterGain);
        
        osc.start(t);
        osc.stop(t + duration);
    });
}

/**
 * 3. Toggle Off - Falling, gentle sound
 */
export function playToggleOff() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    const duration = 0.18;
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    
    osc.type = 'sine';
    
    // Falling pitch (600Hz -> 280Hz)
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(280, t + duration);
    
    // Lowpass filter sweeping down
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);
    filter.Q.value = 1.5;
    
    // Smooth envelope
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    
    osc.start(t);
    osc.stop(t + duration);
}

/**
 * 4. Start sound - Bright ascending arpeggio
 */
export function playStart() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    
    // Pleasant major chord arpeggio: C5-E5-G5-C6
    const notes = [523.25, 659.25, 783.99, 1046.50];
    
    notes.forEach((freq, i) => {
        const startTime = t + (i * 0.08);
        const duration = 0.5;
        
        // Main tone
        const main = createSmoothTone(freq, startTime, duration, 'sine', {
            attack: 0.015,
            release: 0.25,
            peakGain: 0.2,
            filterFreq: 3500
        });
        
        // Harmonic for richness
        const harmonic = createSmoothTone(freq * 2, startTime, duration * 0.7, 'sine', {
            attack: 0.03,
            release: 0.2,
            peakGain: 0.08
        });
        
        if (main) main.gain.connect(masterGain);
        if (harmonic) harmonic.gain.connect(masterGain);
    });
}

/**
 * 5. Error sound - Clear but not harsh warning tone
 */
export function playError() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    
    // Two-tone warning (less harsh than original)
    const frequencies = [440, 330]; // A4 and E4
    
    frequencies.forEach((freq, i) => {
        const startTime = t + (i * 0.15);
        const duration = 0.15;
        
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const filter = audioCtx.createBiquadFilter();
        
        osc.type = 'sine';
        osc.frequency.value = freq;
        
        // Gentle lowpass
        filter.type = 'lowpass';
        filter.frequency.value = 2000;
        filter.Q.value = 2;
        
        // Quick envelope
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.25, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(masterGain);
        
        osc.start(startTime);
        osc.stop(startTime + duration);
    });
}

/**
 * 6. Alert sound - Spacious, attention-grabbing but pleasant
 */
export function playAlert() {
    initAudio();
    if (isSFXMuted) return;
    
    const t = audioCtx.currentTime;
    
    // Create delay effect
    const delay = audioCtx.createDelay();
    delay.delayTime.value = 0.18;
    
    const feedback = audioCtx.createGain();
    feedback.gain.value = 0.3;
    
    const delayFilter = audioCtx.createBiquadFilter();
    delayFilter.type = 'lowpass';
    delayFilter.frequency.value = 1800;
    
    delay.connect(feedback);
    feedback.connect(delayFilter);
    delayFilter.connect(delay);
    delay.connect(masterGain);
    
    // Three-note ascending pattern: E5-G5-B5
    const notes = [659.25, 783.99, 987.77];
    
    notes.forEach((freq, i) => {
        const startTime = t + (i * 0.12);
        const duration = 0.35;
        
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const filter = audioCtx.createBiquadFilter();
        
        osc.type = 'sine';
        osc.frequency.value = freq;
        
        filter.type = 'lowpass';
        filter.frequency.value = 3000;
        
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.22, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(masterGain);
        gain.connect(delay);
        
        osc.start(startTime);
        osc.stop(startTime + duration + 0.5);
    });
}

/**
 * 7. Upgrade sound - Cheerful celebratory chime (improved)
 */
export function playUpgradeSound() {
    initAudio();
    if (isSFXMuted) return;
    
    const now = audioCtx.currentTime;
    
    // Major 7th chord arpeggio: C5-E5-G5-B5
    const notes = [523.25, 659.25, 783.99, 987.77];
    
    const noteLen = 0.10;
    const repeatDelay = 0.65;
    
    // Play twice for celebration
    [0, repeatDelay].forEach(delayOffset => {
        notes.forEach((freq, i) => {
            const startTime = now + delayOffset + (i * noteLen);
            const duration = 0.45;
            
            // Main bell tone
            const main = createSmoothTone(freq, startTime, duration, 'sine', {
                attack: 0.01,
                release: 0.2,
                peakGain: 0.22,
                filterFreq: 4000
            });
            
            // High harmonic for sparkle
            const sparkle = createSmoothTone(freq * 2, startTime, duration * 0.8, 'sine', {
                attack: 0.02,
                release: 0.15,
                peakGain: 0.12
            });
            
            // Sub-harmonic for warmth
            const sub = createSmoothTone(freq * 0.5, startTime, duration * 0.5, 'sine', {
                attack: 0.015,
                release: 0.1,
                peakGain: 0.08,
                filterFreq: 1000
            });
            
            if (main) main.gain.connect(masterGain);
            if (sparkle) sparkle.gain.connect(masterGain);
            if (sub) sub.gain.connect(masterGain);
        });
    });
}

/**
 * 8. Category 5 sound - Epic, powerful celebration
 */
export function playCat5Sound() {
    initAudio();
    if (isSFXMuted) return;
    
    const now = audioCtx.currentTime;
    
    // Extended major 9th chord: C5-E5-G5-B5-D6
    const notes = [523.25, 659.25, 783.99, 987.77, 1174.66];
    
    const noteLen = 0.09;
    const repeatDelay = 0.75;
    
    // Play twice with longer reverb tail
    [0, repeatDelay].forEach(delayOffset => {
        notes.forEach((freq, i) => {
            const startTime = now + delayOffset + (i * noteLen);
            const mainDuration = 0.6;
            const reverbDuration = 2.8;
            
            // Layer 1: Main bell
            const main = audioCtx.createOscillator();
            const mainGain = audioCtx.createGain();
            const mainFilter = audioCtx.createBiquadFilter();
            
            main.type = 'sine';
            main.frequency.value = freq;
            
            mainFilter.type = 'lowpass';
            mainFilter.frequency.value = 4500;
            mainFilter.Q.value = 0.8;
            
            mainGain.gain.setValueAtTime(0, startTime);
            mainGain.gain.linearRampToValueAtTime(0.25, startTime + 0.015);
            mainGain.gain.exponentialRampToValueAtTime(0.001, startTime + mainDuration);
            
            main.connect(mainFilter);
            mainFilter.connect(mainGain);
            mainGain.connect(masterGain);
            
            main.start(startTime);
            main.stop(startTime + mainDuration);
            
            // Layer 2: High sparkle with long decay
            const sparkle = audioCtx.createOscillator();
            const sparkleGain = audioCtx.createGain();
            
            sparkle.type = 'sine';
            sparkle.frequency.value = freq * 2;
            
            sparkleGain.gain.setValueAtTime(0, startTime);
            sparkleGain.gain.linearRampToValueAtTime(0.15, startTime + 0.03);
            sparkleGain.gain.exponentialRampToValueAtTime(0.001, startTime + reverbDuration);
            
            sparkle.connect(sparkleGain);
            sparkleGain.connect(masterGain);
            
            sparkle.start(startTime);
            sparkle.stop(startTime + reverbDuration);
            
            // Layer 3: Warm sub-bass
            if (i < 3) { // Only on first 3 notes
                const sub = audioCtx.createOscillator();
                const subGain = audioCtx.createGain();
                const subFilter = audioCtx.createBiquadFilter();
                
                sub.type = 'sine';
                sub.frequency.value = freq * 0.5;
                
                subFilter.type = 'lowpass';
                subFilter.frequency.value = 800;
                
                subGain.gain.setValueAtTime(0, startTime);
                subGain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
                subGain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4);
                
                sub.connect(subFilter);
                subFilter.connect(subGain);
                subGain.connect(masterGain);
                
                sub.start(startTime);
                sub.stop(startTime + 0.4);
            }
        });
    });
}

/**
 * Get analyser node for visualization
 */
export function getAnalyser() {
    return analyser;
}