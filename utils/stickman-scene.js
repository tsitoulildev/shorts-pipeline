/**
 * Dark Stickman scene builder (pure SVG, no dependencies).
 *
 * One reference character (fixed proportions, versioned and hashed) is posed with
 * joint angles, so every beat of a Short shows the same figure doing something
 * different in a different place. The renderer (sharp) and the QA gates only
 * consume the returned SVG string and metadata.
 */
const crypto = require('crypto');

// Reference character. Changing a number here changes the hash and the version
// recorded on every scene, so a Short can never mix two versions of the figure.
const CHARACTER = Object.freeze({
  version: 'dark-stickman-v4',
  headRadius: 76,
  neck: 22,
  torso: 390,
  upperArm: 150,
  foreArm: 140,
  thigh: 135,
  shin: 140,
  strokes: Object.freeze({ torso: 48, arm: 40, leg: 44 }),
  body: '#030305',
  // v4 look: a cold rim light on the side facing the scene's light makes the silhouette readable on a
  // dark room, the protagonist always has the same cold white eyes, and red glowing eyes belong only
  // to the Other (presence / twist), so red means danger in every Short.
  rimLight: '#9db4e6',
  rimWidth: 10,
  rimOffset: 6,
  eyeColor: '#e6edf9',
  eyeRadius: 11,
  otherEyeColor: '#ff1e2d',
  otherEyeRadius: 17
});
const CHARACTER_HASH = crypto.createHash('sha1').update(JSON.stringify(CHARACTER)).digest('hex').slice(0, 12);

// Angles are degrees from "hanging straight down"; positive swings toward the facing side.
const POSES = Object.freeze({
  stare:  { lean: 0,   tilt: 0,   armF: [[10, 6], [-8, -4]],      legs: [[5, 0], [-5, 0]] },
  walk:   { lean: 4,   tilt: 2,   armF: [[28, 20], [-30, -12]],    legs: [[24, 6], [-22, -14]] },
  reach:  { lean: 8,   tilt: 6,   armF: [[82, 88], [14, 8]],       legs: [[16, 4], [-10, -4]] },
  point:  { lean: 3,   tilt: 0,   armF: [[102, 104], [10, 4]],     legs: [[8, 0], [-8, 0]] },
  fear:   { lean: -6,  tilt: -4,  armF: [[142, 196], [-142, -196]], legs: [[10, 0], [-10, 0]] },
  hold:   { lean: 2,   tilt: -6,  armF: [[62, 168], [10, 6]],      legs: [[6, 0], [-6, 0]] },
  recoil: { lean: -16, tilt: -10, armF: [[104, 140], [84, 120]],   legs: [[-26, -42], [8, 0]] },
  crouch: { lean: 22,  tilt: 10,  armF: [[40, 30], [-16, -10]],    legs: [[74, -34], [58, -52]] }
});

// First-frame legibility (see hook_opening in utils/speech-timing.js): back-light and vignette
// used only for the hook close-up. Tuned against the gate's contrast floor, not the other way round.
const HOOK_HALO = Object.freeze({ rx: 470, ry: 820, color: '#5b6a8f', opacity: 0.6 });
const HOOK_VIGNETTE_OPACITY = 0.55;

const ENVIRONMENTS = ['room-corner', 'hallway', 'bedroom', 'street'];

const COMPOSITIONS = [
  { name: 'hook-closeup', figureX: 540, scale: 1.55, light: 540, floor: 1800, glow: 0.95 },
  { name: 'left-medium', figureX: 330, scale: 0.78, light: 760, floor: 1450, glow: 0.55 },
  { name: 'right-low', figureX: 760, scale: 0.86, light: 260, floor: 1520, glow: 0.6 },
  { name: 'left-high', figureX: 420, scale: 0.66, light: 820, floor: 1380, glow: 0.5 },
  { name: 'right-medium', figureX: 690, scale: 0.76, light: 300, floor: 1450, glow: 0.65 },
  { name: 'center-small', figureX: 540, scale: 0.58, light: 180, floor: 1330, glow: 0.45 },
  { name: 'twist-wide', figureX: 300, scale: 0.62, light: 900, floor: 1400, glow: 0.8 }
];

function stableHash(value) {
  return String(value || '').split('').reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
}

/** Cues come only from the scene lines, never from the shared brand lock. */
function sceneText(prompt) {
  const raw = String(prompt || '');
  const focused = raw.split('\n')
    .filter(line => /^\s*(SCENE|STORY BEAT)\s*:/i.test(line))
    .map(line => line.replace(/^\s*(SCENE|STORY BEAT)\s*:/i, ' '))
    .join(' ').trim();
  return (focused || raw).toLowerCase()
    .replace(/\b(no|without|avoid|never)\s+[a-z\s-]+?(?=[,.;:\n]|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function sceneCues(prompt) {
  const text = sceneText(prompt);
  return {
    text,
    door: /door|bedroom|closet|hallway|room/.test(text),
    phone: /phone|message|text|call|voicemail/.test(text),
    mirror: /mirror|reflection|window/.test(text),
    elevator: /elevator/.test(text),
    stairs: /stair|stairwell/.test(text),
    wall: /wall|knock|tapping/.test(text),
    camera: /camera|surveillance|security/.test(text),
    presence: /shadow|behind|presence|someone|figure|person outside|not you|reflection/.test(text),
    bed: /\bbed\b|bedroom|sleep|pillow|blanket/.test(text),
    hallway: /hallway|corridor|apartment|landing/.test(text),
    street: /street|outside|road|lamp|sidewalk|car\b|night air|alley/.test(text)
  };
}

function beatPosition(prompt) {
  const match = String(prompt || '').match(/BEAT POSITION:\s*(\d+)\s*of\s*(\d+)/i);
  if (!match) return null;
  const position = Math.max(1, Number(match[1]));
  return { position, total: Math.max(position, Number(match[2])) };
}

function pickComposition(beat, hash) {
  if (!beat) return COMPOSITIONS[hash % COMPOSITIONS.length];
  if (beat.position === 1) return COMPOSITIONS[0];
  if (beat.position === beat.total) return COMPOSITIONS[6];
  return COMPOSITIONS[1 + ((beat.position - 2) % 5)];
}

function pickPose(beat, cues, hash) {
  if (!beat) return Object.keys(POSES)[hash % Object.keys(POSES).length];
  if (beat.position === 1) return cues.phone ? 'hold' : 'stare';
  if (beat.position === beat.total) return 'recoil';
  // The rotation alone gives every middle beat a different pose; story cues may swap one
  // pose for a closer match, so a story set entirely around a phone or a door cannot collapse it.
  const rotation = ['walk', 'fear', 'point', 'crouch', 'reach'];
  const pose = rotation[(beat.position - 2) % rotation.length];
  if (cues.phone && pose === 'point') return 'hold';
  if ((cues.door || cues.wall || cues.elevator || cues.stairs) && pose === 'walk') return 'reach';
  return pose;
}

function pickEnvironment(beat, cues) {
  const position = beat ? beat.position : 1;
  const rotated = ENVIRONMENTS[(position - 1) % ENVIRONMENTS.length];
  const named = cues.bed ? 'bedroom' : cues.street ? 'street' : (cues.hallway ? 'hallway' : null);
  // A named setting is shown on alternate beats only; the beats between rotate through the
  // other places, so neighbouring beats always differ even when the whole story is in one room.
  if (named && position % 2 === 1) return named;
  if (named && rotated === named) return ENVIRONMENTS[position % ENVIRONMENTS.length];
  return rotated;
}

const rad = degrees => (degrees * Math.PI) / 180;
const at = (origin, length, degrees) => ({ x: origin.x + length * Math.sin(rad(degrees)), y: origin.y + length * Math.cos(rad(degrees)) });
const f = value => Number(value).toFixed(1);

/** Forward kinematics in local space: feet on y=0, up is negative y, facing is +x. */
function skeleton(poseName, options = {}) {
  // A pose is a name from POSES or an explicit angle set (used by the animator to tween between
  // poses). Only angles change; every bone length comes from CHARACTER.
  const pose = poseName && typeof poseName === 'object' ? poseName : (POSES[poseName] || POSES.stare);
  const C = CHARACTER;
  const tilt = (options.tiltOffset || 0);
  const legDrop = side => {
    const [thigh, shin] = pose.legs[side];
    return C.thigh * Math.cos(rad(thigh)) + C.shin * Math.cos(rad(shin));
  };
  const hip = { x: 0, y: -Math.max(legDrop(0), legDrop(1)) };
  const shoulder = { x: hip.x + C.torso * Math.sin(rad(pose.lean)), y: hip.y - C.torso * Math.cos(rad(pose.lean)) };
  const headAngle = pose.lean + pose.tilt + tilt;
  const head = {
    x: shoulder.x + (C.neck + C.headRadius) * Math.sin(rad(headAngle)),
    y: shoulder.y - (C.neck + C.headRadius) * Math.cos(rad(headAngle))
  };
  const arms = pose.armF.map(([upper, lower]) => {
    const elbow = at(shoulder, C.upperArm, upper);
    return { elbow, hand: at(elbow, C.foreArm, lower) };
  });
  const legs = pose.legs.map(([thigh, shin]) => {
    const knee = at(hip, C.thigh, thigh);
    return { knee, foot: at(knee, C.shin, shin) };
  });
  return { hip, shoulder, head, arms, legs, headAngle };
}

// rimLight = { dx, dy } offset (local units) of the cold rim drawn behind the body, or null.
function figureMarkup(poseName, { fill, eyeColor, eyeOpacity, rimLight = null, eyeGlow = false, eyeRadius = CHARACTER.eyeRadius, tiltOffset = 0 }) {
  const C = CHARACTER;
  const s = skeleton(poseName, { tiltOffset });
  const bones = (color, extra) => {
    const line = (a, b, width) => `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${color}" stroke-width="${width + extra}" stroke-linecap="round"/>`;
    return [
      line(s.hip, s.shoulder, C.strokes.torso),
      ...s.arms.flatMap(arm => [line(s.shoulder, arm.elbow, C.strokes.arm), line(arm.elbow, arm.hand, C.strokes.arm - 4)]),
      ...s.legs.flatMap(leg => [line(s.hip, leg.knee, C.strokes.leg), line(leg.knee, leg.foot, C.strokes.leg - 4)])
    ].join('');
  };
  const parts = [];
  if (rimLight) {
    parts.push(`<g transform="translate(${f(rimLight.dx)} ${f(rimLight.dy)})">${bones(C.rimLight, C.rimWidth)}` +
      `<circle cx="${f(s.head.x)}" cy="${f(s.head.y)}" r="${C.headRadius + C.rimWidth / 2}" fill="${C.rimLight}"/></g>`);
  }
  parts.push(bones(fill, 0), `<circle cx="${f(s.head.x)}" cy="${f(s.head.y)}" r="${C.headRadius}" fill="${fill}"/>`);
  let eyes = '';
  if (eyeColor) {
    const ex = Math.cos(rad(s.headAngle)) * 25;
    const ey = Math.sin(rad(s.headAngle)) * 25;
    const glow = eyeGlow ? ' filter="url(#eyeglow)"' : '';
    eyes = `<circle cx="${f(s.head.x - ex + 14)}" cy="${f(s.head.y - ey - 6)}" r="${eyeRadius}" fill="${eyeColor}" opacity="${eyeOpacity}"${glow}/>` +
      `<circle cx="${f(s.head.x + ex + 14)}" cy="${f(s.head.y + ey - 6)}" r="${eyeRadius}" fill="${eyeColor}" opacity="${eyeOpacity}"${glow}/>`;
  }
  const body = parts.join('');
  return { markup: body + eyes, body, eyes, skeleton: s };
}

// Environment v2: depth and readable places. Every room gets wall texture, a baseboard and floor
// perspective, a dim practical light (warm lamp or cold ceiling light) that separates the planes, and
// the furniture that names the place. Glows use radial gradients (cheap to render, no blur filter).
function floorPerspective(floor, vanishX, color = '#151a24') {
  const lines = [];
  for (const x of [-420, -60, 300, 660, 1020, 1380]) {
    lines.push(`<line x1="${f(vanishX + (x - vanishX) * 0.18)}" y1="${floor}" x2="${x}" y2="1920" stroke="${color}" stroke-width="5"/>`);
  }
  return lines.join('');
}

function warmLamp(x, floor, glow) {
  const top = floor - 520;
  return [
    `<circle cx="${x}" cy="${top + 40}" r="260" fill="url(#warm)" opacity="${(0.55 + glow * 0.3).toFixed(2)}"/>`,
    `<line x1="${x}" y1="${top + 70}" x2="${x}" y2="${floor}" stroke="#151820" stroke-width="10"/>`,
    `<polygon points="${x - 70},${top + 70} ${x + 70},${top + 70} ${x + 46},${top} ${x - 46},${top}" fill="#3a2d1d" stroke="#6b5434" stroke-width="4"/>`,
    `<ellipse cx="${x}" cy="${floor}" rx="60" ry="12" fill="#151820"/>`
  ].join('');
}

function setDressing(name, { side, light, floor, glow, hash }) {
  const parts = [];
  const lampSide = side === 1 ? 112 : 968;
  if (name === 'hallway') {
    const vp = { x: 540, y: 760 };
    // Ceiling lights receding to the far end; the farthest one is dead.
    [[0.12, 1], [0.42, 0.75], [0.68, 0.45], [0.86, 0]].forEach(([t, on]) => {
      const y = lerpN(0, vp.y - 120, t);
      const w = lerpN(260, 70, t);
      parts.push(`<rect x="${f(vp.x - w / 2)}" y="${f(y + 6)}" width="${f(w)}" height="${f(lerpN(18, 6, t))}" fill="${on ? '#c9d6f2' : '#1b2130'}" opacity="${on ? (0.35 + 0.4 * on).toFixed(2) : '1'}"/>`);
      if (on) parts.push(`<ellipse cx="${vp.x}" cy="${f(y + 120 * (1 - t) + 40)}" rx="${f(w * 1.3)}" ry="${f(lerpN(240, 80, t))}" fill="url(#cold)" opacity="${(0.35 * on).toFixed(2)}"/>`);
    });
    // Runner carpet and floor seams converging on the far door.
    parts.push(
      `<polygon points="${vp.x - 60},${vp.y + 150} ${vp.x + 60},${vp.y + 150} ${vp.x + 330},${floor + 220} ${vp.x - 330},${floor + 220}" fill="#170c10" opacity=".9"/>`,
      `<line x1="${vp.x - 150}" y1="${vp.y + 150}" x2="-200" y2="1920" stroke="#1a1f2b" stroke-width="5"/>`,
      `<line x1="${vp.x + 150}" y1="${vp.y + 150}" x2="1280" y2="1920" stroke="#1a1f2b" stroke-width="5"/>`,
      `<circle cx="206" cy="${vp.y + 190}" r="9" fill="#5a6274"/><circle cx="874" cy="${vp.y + 190}" r="9" fill="#5a6274"/>`,
      `<rect x="${vp.x - 50}" y="${vp.y - 60}" width="100" height="210" fill="#06080c" stroke="#2c3343" stroke-width="5"/>`
    );
  } else if (name === 'bedroom') {
    const winX = side === 1 ? 120 : 700;
    const standX = side === 1 ? 560 : 400;
    parts.push(
      `<rect width="1080" height="${floor - 40}" fill="url(#paper)"/>`,
      // Moonlight falling from the window onto the floor.
      `<polygon points="${winX},750 ${winX + 260},750 ${winX + 260 + side * 260},${floor + 260} ${winX + side * 260},${floor + 260}" fill="#9db4e6" opacity=".07"/>`,
      // Curtains framing the window.
      `<path d="M${winX - 40} 300 Q ${winX + 10} 520 ${winX - 20} 790 L ${winX - 70} 790 L ${winX - 70} 300 Z" fill="#0d1018" stroke="#232938" stroke-width="4"/>`,
      `<path d="M${winX + 300} 300 Q ${winX + 250} 520 ${winX + 280} 790 L ${winX + 330} 790 L ${winX + 330} 300 Z" fill="#0d1018" stroke="#232938" stroke-width="4"/>`,
      `<line x1="${winX - 90}" y1="300" x2="${winX + 350}" y2="300" stroke="#2a3040" stroke-width="10"/>`,
      // Nightstand with a small warm lamp.
      `<circle cx="${standX + 60}" cy="${floor - 300}" r="170" fill="url(#warm)" opacity="${(0.4 + glow * 0.25).toFixed(2)}"/>`,
      `<rect x="${standX}" y="${floor - 190}" width="120" height="190" fill="#0e1118" stroke="#2a2f3c" stroke-width="6"/>`,
      `<line x1="${standX + 10}" y1="${floor - 110}" x2="${standX + 110}" y2="${floor - 110}" stroke="#2a2f3c" stroke-width="4"/>`,
      `<polygon points="${standX + 30},${floor - 250} ${standX + 90},${floor - 250} ${standX + 78},${floor - 300} ${standX + 42},${floor - 300}" fill="#3a2d1d" stroke="#6b5434" stroke-width="3"/>`,
      `<line x1="${standX + 60}" y1="${floor - 250}" x2="${standX + 60}" y2="${floor - 190}" stroke="#151820" stroke-width="6"/>`,
      floorPerspective(floor, 540)
    );
  } else if (name === 'street') {
    // Lit windows in the dark buildings (a few warm, one cold), power lines, a moon, wet road.
    const windows = [];
    const blocks = [[30, 760, 190], [250, 620, 160], [760, 700, 210]];
    blocks.forEach(([bx, by, bw], b) => {
      for (let i = 0; i < 6; i += 1) {
        const h = stableHash(`${hash}:win:${b}:${i}`);
        if (h % 3 === 0) continue;
        const wx = bx + 22 + (i % 3) * Math.floor((bw - 44) / 3);
        const wy = by + 40 + Math.floor(i / 3) * 90;
        const warm = h % 5 !== 0;
        windows.push(`<rect x="${wx}" y="${wy}" width="30" height="42" fill="${warm ? '#c9a063' : '#9db4e6'}" opacity="${warm ? '.32' : '.22'}"/>`);
      }
    });
    parts.push(
      `<circle cx="${side === 1 ? 230 : 850}" cy="260" r="58" fill="#d5dae6" opacity=".22"/>`,
      `<circle cx="${side === 1 ? 230 : 850}" cy="260" r="150" fill="url(#cold)" opacity=".35"/>`,
      windows.join(''),
      `<path d="M0 470 Q 270 540 540 480 T 1080 500" fill="none" stroke="#141822" stroke-width="4"/>`,
      `<path d="M0 520 Q 270 600 540 530 T 1080 560" fill="none" stroke="#141822" stroke-width="3"/>`,
      floorPerspective(floor, 540, '#121620'),
      `<ellipse cx="${side === 1 ? 710 : 370}" cy="${floor + 140}" rx="70" ry="210" fill="#c8cbd6" opacity=".06"/>`
    );
  } else {
    // room-corner: wallpaper, the corner's side wall in shadow, a portrait, a warm floor lamp.
    const cornerX = side === 1 ? 900 : 180;
    const frameX = side === 1 ? 640 : 120;
    parts.push(
      `<rect width="1080" height="${floor}" fill="url(#paper)"/>`,
      `<polygon points="${cornerX},0 ${side === 1 ? 1080 : 0},0 ${side === 1 ? 1080 : 0},${floor + 120} ${cornerX},${floor}" fill="#020305" opacity=".55"/>`,
      `<rect x="${frameX + 18}" y="438" width="154" height="214" fill="#0c1018"/>`,
      `<circle cx="${frameX + 95}" cy="520" r="30" fill="#05070b" opacity=".85"/>`,
      `<path d="M${frameX + 45} 652 Q ${frameX + 95} 560 ${frameX + 145} 652 Z" fill="#05070b" opacity=".85"/>`,
      warmLamp(lampSide, floor, glow),
      `<rect x="0" y="${floor - 22}" width="1080" height="22" fill="#0b0e15"/><line x1="0" y1="${floor - 22}" x2="1080" y2="${floor - 22}" stroke="#262c3a" stroke-width="3"/>`,
      floorPerspective(floor, light)
    );
  }
  return parts.join('');
}

function lerpN(a, b, t) { return a + (b - a) * t; }

/** Dark foreground edge (door frame / wall corner) on the side away from the figure: depth in every shot. */
function foregroundMarkup(figureX) {
  const right = figureX < 540;
  const x = right ? 1000 : 0;
  const edge = right ? 1000 : 80;
  return `<rect x="${x}" y="0" width="80" height="1920" fill="#010102"/>` +
    `<line x1="${edge}" y1="0" x2="${edge}" y2="1920" stroke="#2b3345" stroke-width="4"/>`;
}

function environmentMarkup(name, { facing, light, floor, glow, hash }) {
  const side = facing === 1 ? 1 : -1;
  const parts = [];
  if (name === 'hallway') {
    const vp = { x: 540, y: 760 };
    parts.push(
      `<polygon points="0,${floor + 220} 1080,${floor + 220} 1080,0 0,0" fill="#0a0d14"/>`,
      `<polygon points="0,0 1080,0 ${vp.x + 150},${vp.y - 120} ${vp.x - 150},${vp.y - 120}" fill="#07090e"/>`,
      `<polygon points="0,${floor + 220} 1080,${floor + 220} ${vp.x + 150},${vp.y + 150} ${vp.x - 150},${vp.y + 150}" fill="#10131b"/>`,
      `<polygon points="0,0 ${vp.x - 150},${vp.y - 120} ${vp.x - 150},${vp.y + 150} 0,${floor + 220}" fill="#0c0f17"/>`,
      `<polygon points="1080,0 ${vp.x + 150},${vp.y - 120} ${vp.x + 150},${vp.y + 150} 1080,${floor + 220}" fill="#0c0f17"/>`,
      `<rect x="${vp.x - 150}" y="${vp.y - 120}" width="300" height="270" fill="#161b27"/>`,
      `<ellipse cx="${vp.x}" cy="${vp.y + 20}" rx="260" ry="320" fill="#232b3d" opacity="${(glow * 0.5).toFixed(2)}" filter="url(#glow)"/>`,
      `<polygon points="60,${vp.y + 420} 60,${vp.y - 80} 230,${vp.y + 20} 230,${vp.y + 300}" fill="#11151e" stroke="#2a2f3a" stroke-width="8"/>`,
      `<polygon points="1020,${vp.y + 420} 1020,${vp.y - 80} 850,${vp.y + 20} 850,${vp.y + 300}" fill="#11151e" stroke="#2a2f3a" stroke-width="8"/>`
    );
  } else if (name === 'bedroom') {
    const bedX = side === 1 ? 40 : 560;
    const winX = side === 1 ? 120 : 700;
    parts.push(
      '<rect width="1080" height="1920" fill="#090c12"/>',
      `<rect x="0" y="${floor - 40}" width="1080" height="600" fill="#0d1018"/>`,
      `<rect x="${winX}" y="330" width="260" height="420" fill="#101a2b" stroke="#2e3646" stroke-width="12"/>`,
      `<line x1="${winX + 130}" y1="330" x2="${winX + 130}" y2="750" stroke="#2e3646" stroke-width="10"/><line x1="${winX}" y1="540" x2="${winX + 260}" y2="540" stroke="#2e3646" stroke-width="10"/>`,
      `<circle cx="${winX + 190}" cy="430" r="46" fill="#c9ccd6" opacity=".35" filter="url(#soft)"/>`,
      `<ellipse cx="${winX + 130}" cy="800" rx="260" ry="420" fill="#1c2a44" opacity="${(glow * 0.35).toFixed(2)}" filter="url(#glow)"/>`,
      `<rect x="${bedX}" y="${floor - 250}" width="480" height="230" rx="14" fill="#0f131c" stroke="#262b37" stroke-width="10"/>`,
      `<rect x="${bedX + (side === 1 ? 20 : 300)}" y="${floor - 300}" width="160" height="70" rx="22" fill="#171c28"/>`,
      `<rect x="${bedX}" y="${floor - 420}" width="480" height="170" fill="#0b0e15" stroke="#262b37" stroke-width="10"/>`
    );
  } else if (name === 'street') {
    const lampX = side === 1 ? 800 : 280;
    parts.push(
      '<rect width="1080" height="1920" fill="#080b11"/>',
      `<rect x="0" y="${floor - 30}" width="1080" height="600" fill="#0b0e15"/>`,
      `<rect x="30" y="760" width="190" height="${floor - 790}" fill="#0b0e15"/><rect x="250" y="620" width="160" height="${floor - 650}" fill="#0a0d13"/><rect x="760" y="700" width="210" height="${floor - 730}" fill="#0b0e15"/><rect x="990" y="860" width="120" height="${floor - 890}" fill="#0a0d13"/>`,
      `<line x1="${lampX}" y1="420" x2="${lampX}" y2="${floor}" stroke="#262b37" stroke-width="16"/>`,
      `<line x1="${lampX}" y1="420" x2="${lampX + side * -90}" y2="400" stroke="#262b37" stroke-width="14"/>`,
      `<polygon points="${lampX - side * 90 - 30},410 ${lampX - side * 90 + 30},410 ${lampX - side * 90 + 230},${floor} ${lampX - side * 90 - 230},${floor}" fill="#c8cbd6" opacity="${(glow * 0.09).toFixed(2)}" filter="url(#soft)"/>`,
      `<circle cx="${lampX - side * 90}" cy="410" r="34" fill="#d9dce6" opacity=".55" filter="url(#soft)"/>`,
      `<ellipse cx="540" cy="${floor - 40}" rx="620" ry="70" fill="#1a1f2b" opacity=".5" filter="url(#glow)"/>`
    );
  } else {
    parts.push(
      '<rect width="1080" height="1920" fill="url(#bg)"/>',
      `<ellipse cx="${light}" cy="520" rx="360" ry="520" fill="#1c2233" opacity="${(glow * 0.55).toFixed(2)}" filter="url(#glow)"/>`,
      `<line x1="${side === 1 ? 900 : 180}" y1="0" x2="${side === 1 ? 900 : 180}" y2="${floor}" stroke="#151922" stroke-width="14"/>`,
      `<rect x="${side === 1 ? 640 : 120}" y="420" width="190" height="250" fill="none" stroke="#1d222d" stroke-width="10"/>`
    );
  }
  parts.push(setDressing(name, { side, light, floor, glow, hash }));
  // Floor line and low fog shared by every environment; specks are seeded per scene.
  parts.push(
    `<ellipse cx="540" cy="${floor + 60}" rx="480" ry="170" fill="#11141a" opacity=".6"/>`,
    `<line x1="70" y1="${floor}" x2="1010" y2="${floor}" stroke="#20242c" stroke-width="10"/>`,
    `<ellipse cx="${300 + (hash % 400)}" cy="${floor - 20}" rx="520" ry="46" fill="#aab0bf" opacity=".05" filter="url(#glow)"/>`
  );
  const specks = [];
  for (let i = 0; i < 14; i += 1) {
    const h = stableHash(`${hash}:${i}`);
    specks.push(`<circle cx="${h % 1080}" cy="${(h >> 8) % 1500}" r="${1 + (h % 3)}" fill="#c8ccd8" opacity="${(0.05 + (h % 7) / 100).toFixed(2)}"/>`);
  }
  parts.push(specks.join(''));
  return parts.join('');
}

// phase (0..1) is only set by the animator; without it every prop is drawn exactly as before.
function propMarkup(cues, { facing, figureX, accent, hand, phase }) {
  const animated = Number.isFinite(phase);
  const prop = [];
  const doorX = facing === 1 ? 710 : 110;
  if (cues.door) {
    prop.push(
      `<rect x="${doorX}" y="470" width="260" height="760" rx="8" fill="#111319" stroke="#343842" stroke-width="12"/>`,
      `<circle cx="${doorX + (facing === 1 ? 52 : 208)}" cy="850" r="15" fill="${accent}"/>`
    );
    // Animated: the door opens a dark gap on the side away from the handle.
    if (animated && phase > 0.01) {
      const gap = 6 + phase * 70;
      const gapX = facing === 1 ? doorX + 254 - gap : doorX + 6;
      prop.push(`<rect x="${f(gapX)}" y="476" width="${f(gap)}" height="748" fill="#010102" opacity=".92"/>`);
    }
  }
  if (cues.phone) {
    const px = hand ? hand.x : figureX + facing * 145;
    const py = hand ? hand.y : 980;
    prop.push(
      `<rect x="${f(px - 40)}" y="${f(py - 140)}" width="80" height="140" rx="16" fill="#050608" stroke="#d7d9df" stroke-width="7"/>`,
      `<rect x="${f(px - 28)}" y="${f(py - 124)}" width="56" height="100" rx="8" fill="${accent}" opacity="${animated ? (0.45 + 0.4 * phase).toFixed(2) : '.8'}" filter="url(#glow)"/>`
    );
  }
  if (cues.mirror) {
    const mirrorX = facing === 1 ? 735 : 95;
    prop.push(`<rect x="${mirrorX}" y="410" width="250" height="720" rx="22" fill="#171b25" stroke="#4b5160" stroke-width="12"/>`);
  }
  if (cues.elevator) {
    prop.push(
      '<rect x="135" y="360" width="810" height="920" fill="#11141a" stroke="#3b414d" stroke-width="14"/>',
      '<line x1="540" y1="360" x2="540" y2="1280" stroke="#343943" stroke-width="12"/>'
    );
  }
  if (cues.stairs) prop.push('<path d="M80 1360 H270 V1240 H450 V1120 H630 V1000 H810 V880 H1000" fill="none" stroke="#313640" stroke-width="28"/>');
  if (cues.wall) {
    const wallX = facing === 1 ? 855 : 225;
    prop.push(
      `<line x1="${wallX}" y1="300" x2="${wallX}" y2="1560" stroke="#252932" stroke-width="18"/>`,
      `<circle cx="${wallX}" cy="760" r="${animated ? f(40 + 24 * phase) : 52}" fill="none" stroke="${accent}" stroke-width="8" opacity="${animated ? (0.7 - 0.35 * phase).toFixed(2) : '.55'}"/>`,
      `<circle cx="${wallX}" cy="760" r="${animated ? f(80 + 30 * phase) : 92}" fill="none" stroke="${accent}" stroke-width="5" opacity="${animated ? (0.35 - 0.2 * phase).toFixed(2) : '.25'}"/>`
    );
  }
  if (cues.camera) {
    prop.push(
      '<rect x="780" y="310" width="150" height="92" rx="16" fill="#14171d" stroke="#525866" stroke-width="10"/>',
      `<circle cx="825" cy="356" r="24" fill="${accent}"/>`,
      '<path d="M930 338 L1010 304 L1010 408 L930 376 Z" fill="#252a33"/>'
    );
  }
  return prop.join('');
}

/**
 * Build one scene. Returns { svg, meta } where meta is what QA and provenance need:
 * the character version/hash, the pose, the environment and the composition.
 */
function buildStickmanScene(prompt, options = {}) {
  const cues = sceneCues(prompt);
  const hash = stableHash(cues.text);
  const beat = beatPosition(prompt);
  const composition = pickComposition(beat, hash);
  const poseName = pickPose(beat, cues, hash);
  const environment = pickEnvironment(beat, cues);
  const facing = composition.figureX < 540 ? 1 : (composition.figureX > 540 ? -1 : (hash % 2 === 0 ? 1 : -1));
  const accent = hash % 3 === 0 ? '#8d111b' : '#b8bcc5';
  const isTwist = Boolean(beat && beat.position === beat.total && beat.total > 1);

  // Animation options (all optional; without them the scene is byte-identical to the still):
  // pose = angle set to draw instead of the beat's pose, headTilt = degrees, propPhase = 0..1,
  // camera = { zoom >= 1, focusX, focusY } cropping the same 9:16 frame.
  const drawPose = options.pose || poseName;
  // Rim light comes from the side of the scene's light (world px converted to the figure's local units).
  const towardLight = composition.light >= composition.figureX ? 1 : -1;
  const rimLight = {
    dx: (towardLight * facing * CHARACTER.rimOffset) / composition.scale,
    dy: -(CHARACTER.rimOffset * 0.6) / composition.scale
  };
  const main = figureMarkup(drawPose, {
    fill: CHARACTER.body, eyeColor: CHARACTER.eyeColor, eyeOpacity: Math.min(1, 0.6 + composition.glow * 0.4).toFixed(2),
    rimLight, tiltOffset: Number(options.headTilt) || 0
  });
  // World position of the leading hand, for props that must stay in it.
  const lead = main.skeleton.arms[0].hand;
  const hand = { x: composition.figureX + facing * composition.scale * lead.x, y: composition.floor + composition.scale * lead.y };

  let presence = '';
  if (cues.presence || isTwist) {
    const shadowX = composition.figureX < 540 ? 830 : 250;
    // The Other: plain black, no rim light, red glowing eyes (the only red eyes in the channel).
    // Its body is soft and faint before the twist and solid at the twist; the eyes are always crisp and lit.
    const ghost = figureMarkup('stare', { fill: '#020204', eyeColor: CHARACTER.otherEyeColor, eyeOpacity: '0.95', eyeGlow: true, eyeRadius: CHARACTER.otherEyeRadius, tiltOffset: isTwist ? 16 : 0 });
    const ghostTransform = `translate(${shadowX} ${composition.floor}) scale(${(composition.scale * 0.95).toFixed(3)} ${(composition.scale * (isTwist ? 1.22 : 1.0)).toFixed(3)})`;
    presence = `<g opacity="${isTwist ? '.92' : '.38'}"${isTwist ? '' : ' filter="url(#soft)"'} transform="${ghostTransform}">${ghost.body}</g>` +
      `<g opacity="${isTwist ? '1' : '.75'}" transform="${ghostTransform}">${ghost.eyes}</g>`;
  }
  const reflection = cues.mirror
    ? `<g opacity=".24" transform="translate(${facing === 1 ? 860 : 220} ${composition.floor}) scale(${(-facing * composition.scale * 0.8).toFixed(3)} ${(composition.scale * 0.8).toFixed(3)})">${figureMarkup(drawPose, { fill: '#07080b', eyeColor: null }).markup}</g>`
    : '';

  // The hook close-up is the first frame the viewer (and the hook_opening gate) sees. A near-black
  // figure on a near-black room has no readable structure on a phone, so the hook gets a cold
  // back-light behind the figure and a lighter vignette. Other beats keep the darker look.
  const isHook = composition.name === 'hook-closeup';
  const hookHalo = isHook
    ? `<ellipse cx="${composition.figureX}" cy="${composition.floor - 640}" rx="${HOOK_HALO.rx}" ry="${HOOK_HALO.ry}" fill="${HOOK_HALO.color}" opacity="${HOOK_HALO.opacity}" filter="url(#halo)"/>`
    : '';

  let viewBox = '0 0 1080 1920';
  const camera = options.camera;
  if (camera && Number(camera.zoom) > 1) {
    const w = 1080 / Number(camera.zoom);
    const h = 1920 / Number(camera.zoom);
    const x = Math.min(1080 - w, Math.max(0, Number(camera.focusX ?? 540) - w / 2));
    const y = Math.min(1920 - h, Math.max(0, Number(camera.focusY ?? 960) - h / 2));
    viewBox = `${f(x)} ${f(y)} ${f(w)} ${f(h)}`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="${viewBox}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#070910"/><stop offset=".62" stop-color="#0b0e16"/><stop offset="1" stop-color="#030407"/>
        </linearGradient>
        <radialGradient id="vignette"><stop offset=".35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".82"/></radialGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="16"/></filter>
        <filter id="soft"><feGaussianBlur stdDeviation="5"/></filter>
        <filter id="halo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>
        <filter id="eyeglow" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <pattern id="paper" width="64" height="64" patternUnits="userSpaceOnUse"><line x1="1" y1="0" x2="1" y2="64" stroke="#ffffff" stroke-opacity=".028" stroke-width="2"/><circle cx="32" cy="22" r="4" fill="#ffffff" fill-opacity=".022"/></pattern>
        <radialGradient id="warm"><stop offset="0" stop-color="#e0a85f" stop-opacity=".7"/><stop offset=".45" stop-color="#d9a35e" stop-opacity=".22"/><stop offset="1" stop-color="#d9a35e" stop-opacity="0"/></radialGradient>
        <radialGradient id="cold"><stop offset="0" stop-color="#9db4e6" stop-opacity=".5"/><stop offset="1" stop-color="#9db4e6" stop-opacity="0"/></radialGradient>
        <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9d6f2" stop-opacity=".26"/><stop offset="1" stop-color="#c9d6f2" stop-opacity="0"/></linearGradient>
      </defs>
      <rect width="1080" height="1920" fill="url(#bg)"/>
      ${environmentMarkup(environment, { facing, light: composition.light, floor: composition.floor, glow: composition.glow, hash })}
      ${propMarkup(cues, { facing, figureX: composition.figureX, accent, hand: poseName === 'hold' ? hand : null, phase: options.propPhase })}
      ${reflection}
      ${presence}
      ${hookHalo}
      <polygon points="${composition.light - 80},0 ${composition.light + 80},0 ${composition.light + 400},${composition.floor + 40} ${composition.light - 400},${composition.floor + 40}" fill="url(#beam)"/>
      <g transform="translate(${composition.figureX} ${composition.floor}) scale(${(facing * composition.scale).toFixed(3)} ${composition.scale.toFixed(3)})">
        ${main.markup}
      </g>
      ${isHook ? '' : foregroundMarkup(composition.figureX)}
      <rect ${viewBox === '0 0 1080 1920' ? '' : `x="${viewBox.split(' ')[0]}" y="${viewBox.split(' ')[1]}" `}width="${viewBox === '0 0 1080 1920' ? 1080 : viewBox.split(' ')[2]}" height="${viewBox === '0 0 1080 1920' ? 1920 : viewBox.split(' ')[3]}" fill="url(#vignette)" opacity="${isHook ? HOOK_VIGNETTE_OPACITY : 1}"/>
    </svg>`;

  const props = ['door', 'phone', 'mirror', 'elevator', 'stairs', 'wall', 'camera'].filter(key => cues[key]);
  return {
    svg,
    meta: {
      characterVersion: CHARACTER.version,
      characterHash: CHARACTER_HASH,
      pose: poseName,
      environment,
      composition: composition.name,
      props,
      facing,
      presence: Boolean(cues.presence || isTwist)
    }
  };
}

module.exports = {
  CHARACTER, CHARACTER_HASH, POSES, ENVIRONMENTS, COMPOSITIONS,
  buildStickmanScene, sceneCues, sceneText, stableHash, skeleton
};
