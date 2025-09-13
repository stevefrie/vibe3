import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  GROUND_HEIGHT,
  BASE_COUNT,
  BASE_WIDTH,
  BASE_HEIGHT,
  BASE_INITIAL_MISSILES,
  MISSILE_SPEED_MIN,
  MISSILE_SPEED_MAX,
  MISSILE_SPEED_LEVEL_SCALING,
  DEFENSIVE_MISSILE_SPEED,
  EXPLOSION_MAX_RADIUS,
  EXPLOSION_GROWTH_RATE,
  SCORE_PER_MISSILE,
  SCORE_PER_BASE_SAVED,
  BEST_SCORE_STORAGE_KEY,
  FIRE_SOUND_DURATION_SEC,
  SPAWN_INTERVAL_LEVEL_SCALING,
} from '../constants';
import type { Missile, Base, Explosion } from '../types';

interface GameProps {
  onGameOver: (score: number) => void;
}

// ---- Helper functions ----
const computeInitialBases = (): Base[] => {
  const bases: Base[] = [];
  const spacing = (GAME_WIDTH - BASE_COUNT * BASE_WIDTH) / (BASE_COUNT + 1);
  for (let i = 0; i < BASE_COUNT; i++) {
    bases.push({
      id: i,
      position: { x: spacing + i * (BASE_WIDTH + spacing), y: GAME_HEIGHT - GROUND_HEIGHT },
      isDestroyed: false,
      missileCount: BASE_INITIAL_MISSILES,
    });
  }
  return bases;
};

const stepExplosion = (e: Explosion): Explosion | null => {
  let radius = e.radius;
  let expanding = e.isExpanding;
  if (expanding) {
    radius += EXPLOSION_GROWTH_RATE;
    if (radius >= e.maxRadius) expanding = false;
  } else {
    radius -= EXPLOSION_GROWTH_RATE * 1.5; // Shrink faster
  }
  return radius > 0 ? { ...e, radius, isExpanding: expanding } : null;
};

function toGameOver(fn: any): (score: number) => void { return typeof fn === 'function' ? fn : () => {}; }
function computeBestScore(prev: number, current: number): number {
  const p = Number.isFinite(prev) ? prev : 0;
  const c = Number.isFinite(current) ? current : 0;
  return c > p ? c : p;
}

const Game: React.FC<GameProps> = ({ onGameOver }) => {
  // Render state
  const [missiles, setMissiles] = useState<Missile[]>([]);
  const [defensiveMissiles, setDefensiveMissiles] = useState<Missile[]>([]);
  const [explosions, setExplosions] = useState<Explosion[]>([]);
  const [bases, setBases] = useState<Base[]>([]);
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [awaitingRestart, setAwaitingRestart] = useState(false);
  const [bestScore, setBestScore] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.6);

  // Authoritative refs
  const missilesRef = useRef<Missile[]>([]);
  const dMissilesRef = useRef<Missile[]>([]);
  const explosionsRef = useRef<Explosion[]>([]);
  const basesRef = useRef<Base[]>([]);
  const scoreRef = useRef(0);
  const levelRef = useRef(1);
  const missilesForLevelRef = useRef(10);
  const missilesSpawnedRef = useRef(0);
  const awaitingRestartRef = useRef(false);
  const bestScoreRef = useRef(0);

  const gameOverRef = useRef<(score: number) => void>(() => {});
  useEffect(() => { gameOverRef.current = toGameOver(onGameOver); }, [onGameOver]);

  const rafRef = useRef<number | null>(null);
  const lastSpawnTimeRef = useRef(0);
  const gameContainerRef = useRef<HTMLDivElement>(null);

  // ---- Sound ----
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const ambientGainRef = useRef<GainNode | null>(null);
  const soundReadyRef = useRef(false);
  const reverbImpulseRef = useRef<AudioBuffer | null>(null);

  const getAudioContextClass = (): typeof AudioContext | null => (typeof window !== 'undefined' ? (window.AudioContext || (window as any).webkitAudioContext) : null);

  const ensureAudio = useCallback(async () => {
    const AC = getAudioContextClass();
    if (!AC) return false;

    if (!audioCtxRef.current) {
      try {
        const ctx = new AC();
        const master = ctx.createGain();
        master.gain.value = muted ? 0 : volume;
        master.connect(ctx.destination);
        
        const ambient = ctx.createGain();
        ambient.gain.value = muted ? 0 : 0.04; // Low volume for ambient
        ambient.connect(master);

        audioCtxRef.current = ctx;
        masterGainRef.current = master;
        ambientGainRef.current = ambient;

      } catch (e) { return false; }
    }

    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      try { await audioCtxRef.current.resume(); } catch {}
    }
    return !!audioCtxRef.current;
  }, [muted, volume]);

  const connectToMaster = (node: AudioNode) => {
    try {
      const master = masterGainRef.current;
      if (master) { node.connect(master); return true; }
    } catch {}
    return false;
  };
  
  const connectToAmbient = (node: AudioNode) => {
    try {
      const ambient = ambientGainRef.current;
      if(ambient) { node.connect(ambient); return true; }
    } catch {}
    return false;
  }

  useEffect(() => {
    if (masterGainRef.current) {
      try { masterGainRef.current.gain.value = muted ? 0 : volume; } catch {}
    }
    if(ambientGainRef.current) {
        try { ambientGainRef.current.gain.value = muted ? 0 : 0.04; } catch {}
    }
  }, [muted, volume]);

  const unlockAudio = useCallback(async () => {
    if (soundReadyRef.current) return;
    const ok = await ensureAudio();
    if (ok) soundReadyRef.current = true;
  }, [ensureAudio]);

  const buildImpulseResponse = (ctx: AudioContext, dur = 1.6, decay = 3.0): AudioBuffer => {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * dur));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  };

  const getReverbImpulse = (ctx: AudioContext) => {
    if (!reverbImpulseRef.current) {
      try { reverbImpulseRef.current = buildImpulseResponse(ctx); } catch {}
    }
    return reverbImpulseRef.current;
  };

  const makeDistortion = (ctx: AudioContext, amount = 15): WaveShaperNode => {
    const ws = ctx.createWaveShaper();
    const n = 256; const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = ((3 + amount) * x) / (3 + amount * Math.abs(x)); }
    ws.curve = curve; ws.oversample = '4x'; return ws;
  };

  const createNoiseBuffer = (ctx: AudioContext, durSec: number): AudioBuffer => {
    const frames = Math.max(1, Math.floor(ctx.sampleRate * durSec));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  const playFire = useCallback(() => {
    if (muted) return; const ctx = audioCtxRef.current; if (!ctx) return;
    try {
      // Main synth
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1500, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.14);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + FIRE_SOUND_DURATION_SEC);
      osc.connect(gain); connectToMaster(gain);
      osc.start(); osc.stop(ctx.currentTime + FIRE_SOUND_DURATION_SEC + 0.02);

      // Transient snap
      const noise = ctx.createBufferSource(); noise.buffer = createNoiseBuffer(ctx, 0.04);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.4, ctx.currentTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);
      noise.connect(noiseGain); connectToMaster(noiseGain);
      noise.start(); noise.stop(ctx.currentTime + 0.05);

    } catch {}
  }, [muted]);
  
  const playExplosion = useCallback((isHeavy: boolean = false) => {
    if (muted) return; const ctx = audioCtxRef.current; if (!ctx) return;
    try {
        const randomPitch = 1 + (Math.random() - 0.5) * (isHeavy ? 0.4 : 0.2);
        const duration = isHeavy ? 1.4 : 1.0;

        // Noise burst
        const src = ctx.createBufferSource(); src.buffer = createNoiseBuffer(ctx, duration);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1500 * randomPitch, ctx.currentTime);
        bp.frequency.exponentialRampToValueAtTime(150 * randomPitch, ctx.currentTime + duration * 0.8);
        bp.Q.value = 0.7;
        const body = ctx.createGain();
        body.gain.setValueAtTime(isHeavy ? 1.0 : 0.8, ctx.currentTime);
        body.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration * 0.9);
        src.connect(bp); bp.connect(body);

        // Reverb/Echo Path
        const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.15;
        const fb = ctx.createGain(); fb.gain.value = 0.25;
        delay.connect(fb); fb.connect(delay); body.connect(delay); connectToMaster(delay);
        const conv = ctx.createConvolver();
        try { if(getReverbImpulse(ctx)) conv.buffer = getReverbImpulse(ctx); } catch {}
        const revSend = ctx.createGain(); revSend.gain.value = 0.22;
        body.connect(revSend); revSend.connect(conv); connectToMaster(conv);

        // Dry Path
        connectToMaster(body);
        src.start(); src.stop(ctx.currentTime + duration);

        // Sub-bass Thump
        const osc = ctx.createOscillator(); osc.type = 'triangle';
        osc.frequency.setValueAtTime((isHeavy ? 70 : 90) * randomPitch, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(30 * randomPitch, ctx.currentTime + 0.5);
        const g2 = ctx.createGain(); g2.gain.setValueAtTime(isHeavy ? 1.2 : 0.7, ctx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
        const dist = makeDistortion(ctx, isHeavy ? 50 : 20);
        osc.connect(dist); dist.connect(g2); connectToMaster(g2);
        osc.start(); osc.stop(ctx.currentTime + 0.7);
    } catch {}
  }, [muted]);

  const playGameOver = useCallback(() => {
    if (muted) return; const ctx = audioCtxRef.current; if (!ctx) return;
    try {
      const seq = [700, 530, 400, 250];
      seq.forEach((f, i) => {
        const when = ctx.currentTime + i * 0.22;
        const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = f;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.001, when);
        g.gain.exponentialRampToValueAtTime(0.35, when + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
        osc.connect(g); connectToMaster(g);
        osc.start(when); osc.stop(when + 0.2);
      });
    } catch {}
  }, [muted]);
  
  const playLevelStart = useCallback(() => {
    if (muted) return; const ctx = audioCtxRef.current; if (!ctx) return;
    try {
        const seq = [440, 554.37, 659.25, 880];
        seq.forEach((f, i) => {
            const when = ctx.currentTime + i * 0.1;
            const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
            const g = ctx.createGain(); g.gain.setValueAtTime(0.001, when);
            g.gain.exponentialRampToValueAtTime(0.3, when + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);
            osc.connect(g); connectToMaster(g);
            osc.start(when); osc.stop(when + 0.1);
        });
    } catch {}
  }, [muted]);

  const playSound = (which: 'fire' | 'explosion' | 'gameover' | 'baseDestroyed' | 'levelStart') => {
    if (!soundReadyRef.current) return;
    if (which === 'fire') playFire();
    else if (which === 'explosion') playExplosion(false);
    else if (which === 'baseDestroyed') playExplosion(true);
    else if (which === 'gameover') playGameOver();
    else if (which === 'levelStart') playLevelStart();
  };
  
  // Ambient Sound Controller
  useEffect(() => {
    if (!soundReadyRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.value = 30;
    osc2.frequency.value = 30.2; // slight detune for phasing
    
    osc1.start();
    osc2.start();
    connectToAmbient(osc1);
    connectToAmbient(osc2);
    
    return () => {
        try {
            osc1.stop();
            osc2.stop();
            osc1.disconnect();
            osc2.disconnect();
        } catch {}
    }
  }, [soundReadyRef.current]);

  // ---- Best score persistence ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BEST_SCORE_STORAGE_KEY);
      const stored = raw ? parseInt(raw, 10) : 0;
      if (Number.isFinite(stored)) { bestScoreRef.current = stored; setBestScore(stored); }
    } catch {}
  }, []);

  const saveBestScoreIfNeeded = useCallback(() => {
    const nextBest = computeBestScore(bestScoreRef.current, scoreRef.current);
    if (nextBest > bestScoreRef.current) {
      bestScoreRef.current = nextBest; setBestScore(nextBest);
      try { localStorage.setItem(BEST_SCORE_STORAGE_KEY, String(nextBest)); } catch {}
    }
  }, []);

  const commitFrame = useCallback(() => {
    setMissiles([...missilesRef.current]);
    setDefensiveMissiles([...dMissilesRef.current]);
    setExplosions([...explosionsRef.current]);
    setBases([...basesRef.current]);
    setScore(scoreRef.current);
    setLevel(levelRef.current);
    setAwaitingRestart(awaitingRestartRef.current);
    setBestScore(bestScoreRef.current);
  }, []);

  const initBases = useCallback(() => {
    const newBases = computeInitialBases();
    basesRef.current = newBases; setBases(newBases);
  }, []);

  const resetToLevelOne = useCallback(() => {
    scoreRef.current = 0; levelRef.current = 1;
    missilesForLevelRef.current = 10 + 1 * 2; missilesSpawnedRef.current = 0;
    missilesRef.current = []; dMissilesRef.current = []; explosionsRef.current = [];
    initBases();
    commitFrame();
  }, [initBases, commitFrame]);

  useEffect(() => {
    resetToLevelOne();
    awaitingRestartRef.current = false; setAwaitingRestart(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNextLevel = useCallback(() => {
    playSound('levelStart');
    basesRef.current = basesRef.current.map(b => b.isDestroyed ? b : { ...b, missileCount: BASE_INITIAL_MISSILES });
    levelRef.current = levelRef.current + 1;
    missilesForLevelRef.current = 10 + levelRef.current * 2;
    missilesSpawnedRef.current = 0;
    missilesRef.current = []; dMissilesRef.current = []; explosionsRef.current = [];
    commitFrame();
  }, [commitFrame, playSound]);

  const spawnMissile = useCallback((currentTime: number) => {
    if (missilesSpawnedRef.current >= missilesForLevelRef.current) return;
    const startX = Math.random() * GAME_WIDTH; const start = { x: startX, y: 0 };
    const avail = basesRef.current.filter(b => !b.isDestroyed);
    let end; if (avail.length && Math.random() > 0.2) {
      const t = avail[Math.floor(Math.random() * avail.length)];
      end = { x: t.position.x + BASE_WIDTH / 2, y: GAME_HEIGHT - GROUND_HEIGHT };
    } else { end = { x: Math.random() * GAME_WIDTH, y: GAME_HEIGHT - GROUND_HEIGHT }; }
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const speed = MISSILE_SPEED_MIN + Math.random() * (MISSILE_SPEED_MAX - MISSILE_SPEED_MIN) + levelRef.current * MISSILE_SPEED_LEVEL_SCALING;
    missilesRef.current = [...missilesRef.current, { id: currentTime + Math.random(), start, end, current: { ...start }, speed, angle }];
    missilesSpawnedRef.current += 1;
  }, []);

  const loop = useCallback((timestamp: number) => {
    if (awaitingRestartRef.current) return;

    const spawnIntervalMs = Math.max(500, 3000 / (levelRef.current * SPAWN_INTERVAL_LEVEL_SCALING));
    if (timestamp - lastSpawnTimeRef.current > spawnIntervalMs && missilesSpawnedRef.current < missilesForLevelRef.current) {
      spawnMissile(timestamp);
      lastSpawnTimeRef.current = timestamp;
    }

    let nextMissiles: Missile[] = [];
    let nextDMissiles: Missile[] = [];
    let stagedExplosions: Explosion[] = [];

    for (const m of missilesRef.current) {
      const nx = m.current.x + Math.cos(m.angle) * m.speed;
      const ny = m.current.y + Math.sin(m.angle) * m.speed;
      if (ny >= GAME_HEIGHT - GROUND_HEIGHT) {
        let wasBaseDestroyed = false;
        basesRef.current = basesRef.current.map(b => {
          if (!b.isDestroyed && nx >= b.position.x && nx <= b.position.x + BASE_WIDTH) {
            wasBaseDestroyed = true;
            return { ...b, isDestroyed: true };
          }
          return b;
        });
        playSound(wasBaseDestroyed ? 'baseDestroyed' : 'explosion');
        stagedExplosions.push({ id: timestamp + Math.random(), center: { x: nx, y: ny }, radius: 0, maxRadius: 20, isExpanding: true });
      } else {
        nextMissiles.push({ ...m, current: { x: nx, y: ny } });
      }
    }

    for (const d of dMissilesRef.current) {
      const nx = d.current.x + Math.cos(d.angle) * d.speed;
      const ny = d.current.y + Math.sin(d.angle) * d.speed;
      const distToEnd = Math.hypot(d.end.x - nx, d.end.y - ny);
      if (distToEnd < d.speed) {
        stagedExplosions.push({ id: timestamp + Math.random(), center: d.end, radius: 0, maxRadius: EXPLOSION_MAX_RADIUS, isExpanding: true });
        playSound('explosion');
      } else { nextDMissiles.push({ ...d, current: { x: nx, y: ny } }); }
    }

    let nextExplosions: Explosion[] = [];
    for (const e of [...explosionsRef.current, ...stagedExplosions]) {
      const stepped = stepExplosion(e);
      if (!stepped) continue;
      let survivors: Missile[] = [];
      for (const m of nextMissiles) {
        const d = Math.hypot(m.current.x - stepped.center.x, m.current.y - stepped.center.y);
        if (d < stepped.radius) {
          scoreRef.current += SCORE_PER_MISSILE;
          nextExplosions.push({ id: timestamp + Math.random(), center: m.current, radius: 0, maxRadius: Math.min(15, EXPLOSION_MAX_RADIUS), isExpanding: true });
          playSound('explosion');
        } else survivors.push(m);
      }
      nextMissiles = survivors;
      nextExplosions.push(stepped);
    }

    missilesRef.current = nextMissiles;
    dMissilesRef.current = nextDMissiles;
    explosionsRef.current = nextExplosions;

    const remainingBases = basesRef.current.filter(b => !b.isDestroyed);
    if (remainingBases.length === 0 && !awaitingRestartRef.current) {
        saveBestScoreIfNeeded(); playSound('gameover'); awaitingRestartRef.current = true;
        gameOverRef.current(scoreRef.current); commitFrame(); return;
    }
    
    const outOfSpawns = missilesSpawnedRef.current === missilesForLevelRef.current;
    const noProjectiles = missilesRef.current.length === 0 && dMissilesRef.current.length === 0 && explosionsRef.current.length === 0;

    if (outOfSpawns && noProjectiles) {
        scoreRef.current += remainingBases.length * SCORE_PER_BASE_SAVED;
        startNextLevel();
    }
    
    commitFrame();
    rafRef.current = requestAnimationFrame(loop);
  }, [spawnMissile, startNextLevel, saveBestScoreIfNeeded, commitFrame, playSound]);

  useEffect(() => {
    if (!awaitingRestart) { rafRef.current = requestAnimationFrame(loop); }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [loop, awaitingRestart]);

  useEffect(() => {
    if (!awaitingRestart) return;
    const handler = () => {
      awaitingRestartRef.current = false;
      resetToLevelOne();
    };
    window.addEventListener('keydown', handler, { once: true });
    window.addEventListener('mousedown', handler, { once: true });
    window.addEventListener('touchstart', handler, { once: true });
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('touchstart', handler);
    };
  }, [awaitingRestart, resetToLevelOne]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('mousedown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
    return () => {
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('mousedown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, [unlockAudio]);

  const handlePlayerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!gameContainerRef.current || awaitingRestartRef.current) return;
    const rect = gameContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left; const y = e.clientY - rect.top;
    if (y >= GAME_HEIGHT - GROUND_HEIGHT) return;

    let closest: Base | null = null; let minD = Infinity;
    for (const b of basesRef.current) {
      if (b.isDestroyed || b.missileCount <= 0) continue;
      const cx = b.position.x + BASE_WIDTH / 2; const cy = b.position.y - BASE_HEIGHT / 2;
      const d = Math.hypot(x - cx, y - cy); if (d < minD) { minD = d; closest = b; }
    }
    if (!closest) return;

    basesRef.current = basesRef.current.map(b => b.id === closest?.id ? { ...b, missileCount: b.missileCount - 1 } : b);
    const start = { x: closest.position.x + BASE_WIDTH / 2, y: closest.position.y };
    const end = { x, y };
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const m: Missile = { id: Date.now(), start, end, current: { ...start }, speed: DEFENSIVE_MISSILE_SPEED, angle };
    dMissilesRef.current = [...dMissilesRef.current, m];
    playSound('fire');
    setBases(basesRef.current); setDefensiveMissiles(dMissilesRef.current);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="w-full flex flex-wrap items-center justify-between gap-4 px-4 mb-2 text-xl font-bold">
        <div className="text-green-400">SCORE: <span className="text-white">{score}</span></div>
        <div className="text-red-400">LEVEL: <span className="text-white">{level}</span></div>
        <div className="text-cyan-300">BEST: <span className="text-white">{bestScore}</span></div>
        <div className="flex items-center gap-2 text-sm justify-self-end">
          <label className="flex items-center gap-2 cursor-pointer select-none text-cyan-200">
            <input type="checkbox" checked={muted} onChange={(e)=>setMuted(e.target.checked)} className="form-checkbox h-5 w-5 rounded bg-gray-700 border-cyan-400 text-cyan-500 focus:ring-cyan-500" />
            MUTE
          </label>
          <input aria-label="Volume" type="range" min={0} max={1} step={0.05} value={volume} onChange={(e)=>setVolume(parseFloat(e.target.value))} className="w-24 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-cyan-400" />
        </div>
      </div>

      <div
        ref={gameContainerRef}
        onClick={handlePlayerClick}
        className="relative bg-black cursor-crosshair overflow-hidden border-2 border-cyan-600/50"
        style={{ width: GAME_WIDTH, height: GAME_HEIGHT, boxShadow: 'inset 0 0 20px #0ff, 0 0 15px #0ff', background: 'radial-gradient(ellipse at 50% 50%, #1e293b 0%, #020617 80%)' }}
      >
        {missiles.map((m) => {
          const length = Math.hypot(m.current.x - m.start.x, m.current.y - m.start.y);
          return (
            <div key={m.id} style={{ position: 'absolute', transformOrigin: 'top left', left: `${m.start.x}px`, top: `${m.start.y}px`, height: '2px', width: `${length}px`, background: 'linear-gradient(to right, transparent, #f0f)', transform: `rotate(${(m.angle * 180) / Math.PI}deg)`, filter: 'drop-shadow(0 0 4px #f0f)' }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full" style={{filter: 'blur(2px)', background: '#ff0'}} />
            </div>
          );
        })}

        {defensiveMissiles.map((m) => {
          const length = Math.hypot(m.current.x - m.start.x, m.current.y - m.start.y);
          return (
            <div key={m.id} style={{ position: 'absolute', transformOrigin: 'top left', left: `${m.start.x}px`, top: `${m.start.y}px`, height: '2px', width: `${length}px`, background: 'linear-gradient(to right, transparent, #0ff)', transform: `rotate(${(m.angle * 180) / Math.PI}deg)`, filter: 'drop-shadow(0 0 4px #0ff)' }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full" style={{filter: 'blur(2px)'}} />
            </div>
          );
        })}

        {explosions.map((e) => (
          <div key={e.id} className="absolute rounded-full pointer-events-none" style={{
            left: e.center.x - e.radius,
            top: e.center.y - e.radius,
            width: e.radius * 2,
            height: e.radius * 2,
            background: `radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(255,255,0,0.8) 30%, rgba(255,165,0,0.6) 60%, rgba(255,0,0,0) 100%)`,
            boxShadow: `0 0 ${e.radius / 2}px 5px rgba(255,200,0,0.5), inset 0 0 ${e.radius / 3}px rgba(255,255,255,0.5)`,
            transition: 'width 20ms linear, height 20ms linear',
            opacity: e.isExpanding ? 1 : e.radius / e.maxRadius,
          }} />
        ))}

        <div className="absolute bottom-0 left-0 w-full border-t-2 border-green-500/50" style={{ height: GROUND_HEIGHT, background: 'linear-gradient(to top, #043a04, #0a800a 8%, transparent 100%)' }} />

        {bases.map((b) => !b.isDestroyed && (
          <React.Fragment key={b.id}>
            <div className="absolute" style={{ left: b.position.x, top: b.position.y - BASE_HEIGHT, width: BASE_WIDTH, height: BASE_HEIGHT, perspective: '100px' }}>
                <div className="w-full h-full bg-cyan-900 rounded-t-lg border-t-2 border-cyan-400" style={{ boxShadow: 'inset 0 4px 8px rgba(0,0,0,0.5), 0 0 10px #0ff', transform: 'rotateX(20deg)' }}>
                    <div className="w-1/2 h-1 mx-auto mt-2 bg-cyan-300 rounded-full opacity-75 animate-pulse" />
                </div>
            </div>
            <div className="absolute text-center font-bold text-white" style={{ left: b.position.x, top: b.position.y - BASE_HEIGHT - 20, width: BASE_WIDTH, textShadow: '0 0 5px black' }}>{b.missileCount}</div>
          </React.Fragment>
        ))}

        {awaitingRestart && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 select-none backdrop-blur-sm">
            <div className="text-center p-8 bg-black/50 rounded-lg border border-cyan-500 shadow-lg shadow-cyan-500/20">
              <div className="text-white text-5xl font-bold mb-4" style={{textShadow: '0 0 10px #f0f, 0 0 20px #f0f'}}>GAME OVER</div>
              <div className="text-cyan-200 text-xl mb-1">Final Score: <span className="font-bold text-white text-2xl">{score}</span></div>
              <div className="text-cyan-200 text-lg mb-6">Best Score: <span className="font-bold text-white text-xl">{bestScore}</span></div>
              <div className="text-cyan-100 text-2xl animate-pulse">PRESS ANY KEY</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Game;
