// GLSL ES 3.00 port of the reel renderer: dayN/glr.py (faces, sun/moon shadow map, ground, water, sky) and the post
// pass (gpu.post for Day 2, day3.post for Day 3). Same camera maths as engine.project, same light formulas, so framing
// and colours match the reels. `style` picks the renderer generation: 0 = Day 2 (glowing river), 1 = Day 3 (reference
// water, far land to the horizon, sun and clouds by day, bottom faces and fine cubes). With Day 2's night values the
// Day 3 code reduces to Day 2's, so only the water, the far land and the post pass switch on `style`.
// W is the canvas width in engine pixels (the 540-wide reel frame sits in the middle, frame_x0 from the left);
// `res` = canvas pixels per engine pixel.

const HEAD = `precision highp float; precision highp int; precision highp sampler2D;
`;

const HASH = `
float hash2(float xf, float yf, uint s) {
    int xi = int(xf), yi = int(yf);
    uint h = uint(xi) * 374761393u + uint(yi) * 668265263u + s * 982451653u;
    h = (h ^ (h >> 13)) * 1274126177u;
    h = h ^ (h >> 16);
    return float(h) / 4294967296.0;
}
float vnoise(vec2 q, uint sd) {
    vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
    float a = hash2(i.x, i.y, sd), b = hash2(i.x + 1.0, i.y, sd), c = hash2(i.x, i.y + 1.0, sd), d = hash2(i.x + 1.0, i.y + 1.0, sd);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const COMMON = `
uniform vec2 cam_c; uniform float cam_cs, cam_sn, cam_ca, cam_sa, cam_zoom, cam_D, cam_fy, W, H;
uniform vec3 AMB, MOON, SPILL, WARM, FOAM, WATERC; uniform float MOON_EL; uniform vec2 moon_dir;
uniform sampler2D river_d; uniform vec4 glows[8]; uniform float glow_r[8]; uniform int n_glows;
uniform vec3 fire_pos; uniform float fire_k; uniform float t; uniform float t_fire, t_sky;   // water, fire, sky clocks (Motion buttons)
uniform float day, wglow, em_k, gk, shade_k; uniform int style;
uniform sampler2D shadow_map; uniform mat4 light_m; uniform float shadow_bias;

vec4 project(vec3 p, out float dz) {
    float dx = p.x - cam_c.x, dy = p.y - cam_c.y;
    float rx = cam_cs * dx + cam_sn * dy;
    float ry = -cam_sn * dx + cam_cs * dy;
    dz = ry * cam_sa + p.z * cam_ca;
    float w = (cam_D - dz) / cam_D;
    float sx = cam_zoom * rx, sy = cam_zoom * (ry * cam_ca - p.z * cam_sa);
    return vec4(sx / (W * 0.5), (1.0 - 2.0 * cam_fy) * w - 2.0 * sy / H, (-dz / 30000.0) * w, w);
}

float spill(vec3 p) {
    vec2 uv = (clamp(p.xy, 0.0, 799.0) + 0.5) / 800.0;
    float d = texture(river_d, uv).r * 255.0 / 4.0;
    float s = exp(-max(d - 8.0, 0.0) / 7.0) * exp(-max(p.z, 0.0) / 18.0) * (d > 8.0 ? 1.0 : 0.0);
    for (int i = 0; i < 8; i++) {
        if (i >= n_glows) break;
        s += glows[i].w * exp(-length(p - glows[i].xyz) / glow_r[i]);
    }
    return clamp(s, 0.0, 1.6);
}

float fire_at(vec3 p) {
    vec3 d = p - fire_pos; d.z = p.z - 3.0;
    return fire_k / (1.0 + dot(d, d) / 256.0);
}

float shadow_at(vec3 p) {
    vec4 l = light_m * vec4(p, 1.0);
    vec3 q = l.xyz * 0.5 + 0.5;
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
    float s = 0.0;
    vec2 texel = 1.0 / vec2(textureSize(shadow_map, 0));
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
        float d = textureLod(shadow_map, q.xy + vec2(i, j) * texel, 0.0).r;
        s += (d < q.z - shadow_bias) ? 1.0 : 0.0;
    }
    return s / 9.0;
}
`;

// one exposed face per instance; position.xy = the quad corner (a, b); face 5 = bottom
const CORNER = `
vec3 corner(int f, float a, float b) {
    if (f == 0) return vec3(a, b, 1.0);
    if (f == 1) return vec3(1.0, a, b);
    if (f == 2) return vec3(0.0, b, a);
    if (f == 3) return vec3(b, 1.0, a);
    if (f == 4) return vec3(a, 0.0, b);
    return vec3(b, a, 0.0);
}
`;

export const FACE_VS = HEAD + `
in vec3 position; in vec3 aPos; in vec4 aCol; in vec4 aMisc;
uniform float q;
out vec3 v_world; out vec3 v_base; out vec3 v_mid; out vec3 v_col; out float v_ao; out float v_key; flat out int v_flags; out float v_dz;
` + COMMON + CORNER + `
uniform float xf_on, xf_pitch, xf_hz; uniform vec4 xf;            // moving meshes (dragon flight, walkers): pitch, yaw, move
vec3 xform(vec3 p) {
    if (xf_on < 0.5) return p;
    float cp = cos(xf_pitch), sp = sin(xf_pitch);
    vec3 a = vec3(p.x * cp + (p.z - xf_hz) * sp, p.y, -p.x * sp + (p.z - xf_hz) * cp + xf_hz);
    float c = cos(xf.w), s = sin(xf.w);
    return vec3(c * a.x - s * a.y + xf.x, s * a.x + c * a.y + xf.y, a.z + xf.z);
}

void main() {
    int fl = int(aCol.w + 0.5);
    float size = aMisc.z / 100.0;
    vec3 lb = aPos / q - 64.0;
    vec3 base = xform(lb);
    vec3 p = xform(lb + corner(fl & 7, position.x, position.y) * size);
    v_world = p; v_base = base; v_mid = xform(lb + 0.5 * size); v_col = aCol.rgb / 255.0; v_ao = aMisc.x / 200.0; v_key = aMisc.y; v_flags = fl;
    float dz;
    gl_Position = project(p, dz);
    v_dz = dz;
}
`;

export const FACE_FS = HEAD + `
in vec3 v_world; in vec3 v_base; in vec3 v_mid; in vec3 v_col; in float v_ao; in float v_key; flat in int v_flags; in float v_dz;
layout(location = 0) out vec4 o_col; layout(location = 1) out vec4 o_em; layout(location = 2) out vec4 o_z;
uniform vec2 cam_right; uniform float water_speed, RY;
` + COMMON + HASH + `
void main() {
    int f = v_flags & 7;
    bool emis = (v_flags & 8) != 0, flowing = (v_flags & 16) != 0, cliff = (v_flags & 32) != 0;
    vec3 n = f == 0 ? vec3(0, 0, 1) : f == 1 ? vec3(1, 0, 0) : f == 2 ? vec3(-1, 0, 0) : f == 3 ? vec3(0, 1, 0) :
             f == 4 ? vec3(0, -1, 0) : vec3(0, 0, -1);
    vec3 base = v_col;
    if (flowing) {                                    // Day 2: dio.animate_water / span.cliff_waterfall, foam falling with gravity
        bool foam;
        if (cliff) {
            float ph = sqrt(max(v_key, 0.0) * 2.0 / 30.0) - t;
            foam = hash2(v_base.y, floor(ph * 9.0), 3u) < 0.45 || abs(v_base.y - RY) > 7.0;
        } else {
            float ph = sqrt(max(v_key, 0.0) * 2.0 / 30.0) - t * water_speed;
            foam = hash2(v_base.x + v_base.y, floor(ph * 9.0), 5u) < 0.42;
        }
        base = foam ? FOAM : WATERC;
    }
    vec3 col;
    if (emis) {
        float flick = 0.9 + 0.1 * sin(t_fire * 13.0 + floor(v_world.x) * 0.7 + floor(v_world.z));
        float k = f == 0 ? 1.0 : (dot(n.xy, cam_right) < 0.0 ? 0.92 : 0.84);
        col = base * k * flick;
        o_em = vec4(col * em_k, 1.0);
    } else {
        vec3 c0 = style == 1 ? v_mid : floor(v_world - n * 0.5) + 0.5;
        vec3 extra = SPILL * 0.9 * spill(c0) * wglow + WARM * fire_at(c0);
        float sh = shadow_at(v_world + n * 0.6);
        if (f == 0) {
            col = base * (AMB + MOON * sin(MOON_EL) * (1.0 - shade_k * sh) + extra) * v_ao;
        } else if (f == 5) {
            col = base * (AMB * 0.55 + extra * 0.6) * v_ao;
        } else {
            float lam = max(0.0, dot(n.xy, moon_dir)) * cos(MOON_EL);
            col = base * (AMB * 0.9 + MOON * lam * (1.0 - shade_k * sh) + extra * 0.9) * v_ao;
        }
        o_em = vec4(0.0);
    }
    o_col = vec4(col, 1.0);
    o_z = vec4(v_dz, 0, 0, 1);
}
`;

export const SHADOW_VS = HEAD + `
in vec3 position; in vec3 aPos; in vec4 aCol; in vec4 aMisc;
uniform float q; uniform mat4 light_m;
` + CORNER + `
uniform float xf_on, xf_pitch, xf_hz; uniform vec4 xf;            // moving meshes (dragon flight, walkers): pitch, yaw, move
vec3 xform(vec3 p) {
    if (xf_on < 0.5) return p;
    float cp = cos(xf_pitch), sp = sin(xf_pitch);
    vec3 a = vec3(p.x * cp + (p.z - xf_hz) * sp, p.y, -p.x * sp + (p.z - xf_hz) * cp + xf_hz);
    float c = cos(xf.w), s = sin(xf.w);
    return vec3(c * a.x - s * a.y + xf.x, s * a.x + c * a.y + xf.y, a.z + xf.z);
}
void main() {
    int fl = int(aCol.w + 0.5);
    vec3 p = xform(aPos / q - 64.0 + corner(fl & 7, position.x, position.y) * (aMisc.z / 100.0));
    gl_Position = light_m * vec4(p, 1.0);
}
`;
export const SHADOW_FS = HEAD + `out vec4 o; void main() { o = vec4(1.0); }`;

export const QUAD_VS = HEAD + `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const GROUND_FS = HEAD + `
layout(location = 0) out vec4 o_col; layout(location = 1) out vec4 o_em; layout(location = 2) out vec4 o_z;
uniform sampler2D ground_tex; uniform sampler2D horizon;
uniform float cliff_x0, low, persp, orbit, res, frame_x0, crack_k, scar_k, stars, low_fall_r; uniform int mode;
uniform vec3 SKY_LOW, SKY_TOP, BG; uniform vec2 sun_px, fall_foot;
` + COMMON + HASH + `
float cliff_x(float y) { return cliff_x0 + 8.0 * sin(y * 0.03) + 4.0 * sin(y * 0.11 + 1.0); }
vec3 layer(float hc, float u, float v, out float ry) {
    float den = cam_D * cam_ca + v * cam_sa;
    ry = (v * cam_D - v * hc * cam_ca + hc * cam_D * cam_sa) / den;
    float sc = cam_D / max(cam_D - ry * cam_sa - hc * cam_ca, 1e-6);
    float rx = u / sc;
    return vec3(cam_c.x + cam_cs * rx - cam_sn * ry, cam_c.y + cam_sn * rx + cam_cs * ry, hc);
}
vec4 tex800(sampler2D s, vec2 p) { return texture(s, (clamp(floor(p), 0.0, 799.0) + 0.5) / 800.0); }
vec3 far_forest(vec2 q) {                                             // day3/glr.py far_forest: dense treetops, autumn mix
    vec2 cell = floor(q / 2.5), f = fract(q / 2.5);
    float h = hash2(cell.x, cell.y, 85u), autumn = 0.15 + 0.45 * vnoise(q / 45.0, 83u);
    vec3 c = h < 0.30 ? vec3(22.0, 58.0, 40.0) : mix(vec3(30.0, 72.0, 42.0), vec3(60.0, 106.0, 52.0), vnoise(q / 6.0, 81u));
    float a = hash2(cell.x, cell.y, 86u);
    if (h >= 0.30 && a < autumn) c = a < autumn * 0.45 ? vec3(198.0, 108.0, 40.0) : a < autumn * 0.8 ? vec3(214.0, 168.0, 56.0) : vec3(170.0, 62.0, 40.0);
    float r = length(f - vec2(0.42, 0.40));
    float lit = r > 0.62 ? 0.55 : 0.80 + 0.35 * clamp(1.0 - length(f - vec2(0.30, 0.28)) * 1.6, 0.0, 1.0);
    return c / 255.0 * lit;
}
float fbm1(float x, uint sd) { return 0.62 * vnoise(vec2(x, 0.5), sd) + 0.26 * vnoise(vec2(x * 2.3, 1.5), sd + 7u) + 0.12 * vnoise(vec2(x * 5.1, 2.5), sd + 13u); }
float ridge_a(float x) { return 20.0 + 62.0 * pow(fbm1(x / 95.0, 91u), 1.7) + 9.0 * fbm1(x / 22.0, 92u); }
float ridge_b(float x) { return 9.0 + 30.0 * fbm1(x / 58.0, 93u) + 4.0 * fbm1(x / 12.0, 94u); }
float ridge_c(float x) { return 3.0 + 13.0 * fbm1(x / 34.0, 95u); }

void main() {
    vec2 px = vec2(gl_FragCoord.x / res - 0.5, H - gl_FragCoord.y / res - 0.5);   // engine pixel (row 0 at the top)
    float u = (px.x + 0.5 - W / 2.0) / cam_zoom;
    float v = (px.y + 0.5 - H * cam_fy) / cam_zoom;
    bool ok = cam_D * cam_ca + v * cam_sa > 1e-6;
    float ry0, ry1;
    vec3 p0 = layer(0.0, u, v, ry0), p1 = layer(-low, u, v, ry1);
    bool on_top = ok && p0.x >= cliff_x(p0.y);
    bool on_low = ok && !on_top && p1.x < cliff_x(p1.y);
    vec3 p = on_top ? p0 : p1;
    float ry = on_top ? ry0 : ry1;
    float ext = style == 1 && persp > 0.5 ? 2600.0 : 40.0;              // Day 3 wides: far forest out to the haze
    bool near_world = p.x > -ext && p.x < 800.0 + ext && p.y > -ext && p.y < 800.0 + ext;
    bool in_haze = style == 1 && persp > 0.5 && -(ry * cam_sa + p.z * cam_ca) / cam_sa > 480.0;   // day3/glr.py: land ends in the haze
    bool land = (on_top || on_low) && near_world && !in_haze;
    if (mode == 0) { o_col = vec4(land ? 1.0 : 0.0); o_em = vec4(0); o_z = vec4(0); gl_FragDepth = 1.0; return; }
    if (land) {
        bool inside = p.x >= 0.0 && p.x < 800.0 && p.y >= 0.0 && p.y < 800.0;
        vec4 g = tex800(ground_tex, p.xy);
        int fl = int(g.a * 255.0 + 0.5);
        vec3 far_land = vec3(60.0, 88.0, 44.0) / 255.0;
        if (style == 1) far_land = far_forest(p.xy);                   // beyond the world: far forest, seen through fog
        vec3 base = inside ? g.rgb : far_land;
        bool water = inside && (on_top ? (fl & 1) != 0 : (fl & 2) != 0);
        float sh = style == 1 ? shadow_at(p + vec3(0, 0, 0.3)) : (on_top ? shadow_at(vec3(p.xy, 0.3)) : 0.0);
        vec3 lit = base * gk * (AMB + MOON * sin(MOON_EL) * (1.0 - shade_k * sh)) * (on_top ? 1.0 : 0.85);
        lit += base * SPILL * 0.9 * spill(p) * wglow + base * WARM * fire_at(p);
        vec3 col = lit, em = vec3(0.0);
        if (water && style == 0) {                                      // Day 2: glowing river with drifting foam
            float flow = hash2(p.x + t * 9.0, p.y, 2u);
            vec3 wcol = flow < 0.2 ? FOAM : WATERC * (0.9 + 0.1 * sin(p.x * 0.5 + t * 6.0));
            col = wcol; em = wcol * em_k;
        } else if (water) {
            // Day 3 reference water: still water lit teal in 3x3 patches, drifting cream foam, pale algae; mint lanes in the
            // river's main channel; cyan glow only near falls
            float rd = on_top ? texture(river_d, (clamp(p.xy, 0.0, 799.0) + 0.5) / 800.0).r * 255.0 / 4.0 : 99.0;
            float pch = hash2(floor(p.x / 3.0), floor(p.y / 3.0), 11u);
            vec3 still = mix(vec3(0.13, 0.50, 0.53), vec3(0.17, 0.74, 0.68), pch);
            float drift = floor(t * 1.6);
            bool foam = hash2(p.x - drift, p.y + floor((p.x - drift) / 5.0), 13u) < 0.045;
            bool algae = hash2(floor(p.x / 2.0), floor(p.y / 2.0), 17u) < 0.07 && hash2(p.x, p.y, 19u) < 0.7;
            vec3 w = still;
            if (algae) w = vec3(0.58, 0.88, 0.74);
            if (foam) w = vec3(0.95, 0.93, 0.86);
            float lane = clamp(1.0 - rd / 5.5, 0.0, 1.0);
            if (lane > 0.0 && hash2(floor(p.y / 2.0) * 7.0, floor((p.x + t * 6.0) / 2.0), 21u) < 0.12 + 0.30 * lane) {
                w = hash2(floor(p.x + t * 8.0), p.y, 23u) < 0.12 ? vec3(0.80, 1.0, 0.90) : mix(w, vec3(0.70, 0.99, 0.85), lane);
            }
            float gf = on_top ? 0.0 : clamp(1.0 - length(p.xy - fall_foot) / low_fall_r, 0.0, 1.0);
            w = mix(w, vec3(0.30, 0.86, 0.88), clamp(gf * 1.1, 0.0, 1.0));
            float spark = (day > 0.5 && hash2(p.x + floor(t * 5.0), p.y, 29u) < 0.012) ? 1.0 : 0.0;
            vec3 wl = w * (AMB * 0.8 + MOON * sin(MOON_EL) * 0.75 * (1.0 - 0.5 * sh)) + spark * vec3(0.5);
            vec3 we = w / 1.6;
            col = mix(wl, we, wglow);
            em = we * wglow * (0.35 + 0.65 * max(lane, gf)) + we * gf * (1.0 - wglow) * 0.6;
        }
        if (on_top && (fl & 4) != 0) {                                  // fissures: glowing while they open, a dark scar after
            if (crack_k > 0.0) { col = max(col, SPILL * crack_k); em = SPILL * crack_k; }
            else col = mix(col, col * vec3(0.32, 0.26, 0.22), scar_k);
        }
        float dz = ry * cam_sa + p.z * cam_ca;
        o_col = vec4(col, 1); o_em = vec4(em, 1); o_z = vec4(dz, 0, 0, 1);
        gl_FragDepth = (-dz / 30000.0) * 0.5 + 0.5;
        return;
    }
    // sky above the horizon (first land row per column from the mask pass); stars and moon fixed to the reel frame
    float hy = texture(horizon, vec2(gl_FragCoord.x / (W * res), 0.5)).r;
    vec2 fp = px - vec2(frame_x0, 0.0);
    float uu = fp.x + orbit * 9.0, vv = hy - px.y;
    float k = clamp(vv / (H * 0.55), 0.0, 1.0);
    vec3 sky = SKY_LOW * (1.0 - k) + SKY_TOP * k;
    vec3 em = vec3(0.0);
    float band = exp(-pow((uu * 0.42 + vv - 330.0) / 70.0, 2.0));
    float cloud = hash2(floor(uu / 5.0), floor(vv / 5.0), 61u) * 0.6 + hash2(floor(uu / 13.0), floor(vv / 13.0), 62u) * 0.8;
    sky += band * cloud * 0.11 * vec3(0.75, 0.8, 1.0) * k * stars;
    float cl = vnoise(vec2(uu / 70.0 + t_sky * 0.02, vv / 18.0), 71u) * 0.65 + vnoise(vec2(uu / 24.0, vv / 8.0), 72u) * 0.35;
    float cm = smoothstep(0.56, 0.70, cl) * smoothstep(0.04, 0.2, k) * (1.0 - smoothstep(0.5, 0.85, k));
    cm = floor(cm * 4.0 + 0.5) / 4.0;                                 // day clouds, stepped like pixel art
    sky = mix(sky, mix(vec3(0.96, 0.95, 0.92), SKY_LOW * 1.15, 0.25), cm * (1.0 - stars) * 0.85);
    float sd = length(fp - sun_px);
    sky += (1.0 - stars) * (pow(clamp(1.0 - sd / 160.0, 0.0, 1.0), 2.0) * 0.35 * vec3(1.0, 0.85, 0.6));
    if (stars < 0.5 && sd < 15.0) { sky = vec3(1.0, 0.97, 0.86); em = vec3(0.6, 0.55, 0.4); }
    float h1 = hash2(uu, vv, 41u);
    bool up = k > 0.06 && hash2(uu, vv, 44u) < stars;
    float tw = 0.65 + 0.35 * sin(t_sky * (2.0 + mod(3.0 * h1 * 100.0, 3.0)) + h1 * 300.0);
    vec3 tint = mod(h1 * 1e4, 1.0) < 0.3 ? vec3(1.0, 0.86, 0.72) : vec3(0.82, 0.9, 1.0);
    if (up && h1 < 0.006 + 0.01 * band) sky = max(sky, tint * 0.42 * tw);
    if (up && h1 < 0.0018) sky = max(sky, tint * 0.85 * tw);
    if (up && hash2(floor(float(int(uu)) / 2.0), floor(float(int(vv)) / 2.0), 43u) < 0.0011) { sky = max(sky, tint * tw); em = tint * 0.7 * tw; }
    vec2 mc = vec2(540.0 * 0.80 - (orbit - 40.0) * 1.5, 52.0);
    float md = length(fp - mc);
    if (md < 13.0 && stars > 0.3) { sky = mix(sky, vec3(0.86, 0.9, 0.98), stars); em = vec3(0.5, 0.55, 0.6) * stars; }
    sky += pow(clamp(1.0 - md / 70.0, 0.0, 1.0), 2.0) * 0.25 * vec3(0.5, 0.6, 0.8) * stars;
    if (style == 1) {                                                  // day3/glr.py: hills and mountains on the horizon
        float xs = floor(uu / 2.0) * 2.0, vq = floor(vv);
        vec3 lt = AMB + MOON * sin(MOON_EL) * 0.9;
        float ha = ridge_a(xs), hb = ridge_b(xs), hc = ridge_c(xs) + (hash2(floor(xs / 3.0), 0.0, 96u) < 0.5 ? 1.0 : 0.0);
        if (vq < ha) {
            float face = ridge_a(xs + 10.0) > ridge_a(xs - 10.0) ? 0.84 : 1.06;
            vec3 rock = vec3(0.44, 0.50, 0.60) * face;
            if (ha > 52.0 && vq > ha - 4.0 - 0.18 * (ha - 52.0)) rock = vec3(0.93, 0.95, 0.98) * face;
            sky = mix(rock * lt, SKY_LOW, 0.62); em = vec3(0.0);
        }
        if (vq < hb) {
            float face = ridge_b(xs + 8.0) > ridge_b(xs - 8.0) ? 0.87 : 1.05;
            vec3 woods = (hash2(xs, vq, 97u) < 0.25 ? vec3(0.16, 0.30, 0.25) : vec3(0.22, 0.38, 0.30)) * face;
            sky = mix(woods * lt, SKY_LOW, 0.52); em = vec3(0.0);
        }
        if (vq < hc) {
            vec3 near = hash2(xs, vq, 98u) < 0.3 ? vec3(0.17, 0.32, 0.22) : vec3(0.24, 0.40, 0.26);
            if (hash2(xs, vq, 99u) < 0.08) near = vec3(0.55, 0.38, 0.18);
            sky = mix(near * lt, SKY_LOW, 0.42); em = vec3(0.0);
        }
    }
    o_col = vec4(sky * persp + BG * (1.0 - persp), 1); o_em = vec4(em * persp, 1); o_z = vec4(-1e9, 0, 0, 1);
    gl_FragDepth = 1.0;
}
`;

// first land row per column, in engine pixels (glr: mask.argmax(0), H where a column has no land)
export const HORIZON_FS = HEAD + `
uniform sampler2D mask; uniform float res, H;
out vec4 o;
void main() {
    int x = int(gl_FragCoord.x);
    int rows = textureSize(mask, 0).y;
    float first = H;
    for (int i = 0; i < 4096; i++) {
        if (i >= rows) break;
        if (texelFetch(mask, ivec2(x, rows - 1 - i), 0).r > 0.5) { first = floor(float(i) / res); break; }
    }
    o = vec4(first, 0, 0, 1);
}
`;

// upright pixel sprites (engine.draw_sprite): constant depth at the anchor + bias, fog by distance
export const SPRITE_VS = HEAD + `
in vec3 position; in vec3 aAnchor; in vec4 aRect; in vec4 aInfo;
uniform vec2 atlas;
out vec2 v_uv; out float v_dz; out float v_ry; flat out float v_em;
` + COMMON + `
void main() {
    float dz;
    vec4 cp = project(aAnchor, dz);
    float a = position.x, b = position.y, scale = aInfo.x;
    bool shown = mod(floor(t_fire * 10.0), aInfo.w) == aInfo.z;
    vec2 off = vec2((a - 0.5) * aRect.z * cam_zoom * scale / (W * 0.5), b * aRect.w * cam_zoom * scale * 2.0 / H);
    gl_Position = shown && dz < cam_D * 0.92 ? cp + vec4(off, 0.0, 0.0) : vec4(2.0, 2.0, 2.0, 1.0);
    gl_Position.z = -(dz + 0.8) / 30000.0 * cp.w;
    v_uv = (aRect.xy + vec2(a * aRect.z, (1.0 - b) * aRect.w)) / atlas;
    v_dz = dz + 0.8;
    float dx = aAnchor.x - cam_c.x, dy = aAnchor.y - cam_c.y;
    v_ry = -cam_sn * dx + cam_cs * dy;
    v_em = aInfo.y;
}
`;
export const SPRITE_FS = HEAD + `
in vec2 v_uv; in float v_dz; in float v_ry; flat in float v_em;
layout(location = 0) out vec4 o_col; layout(location = 1) out vec4 o_em; layout(location = 2) out vec4 o_z;
uniform sampler2D sprites; uniform vec3 sprite_k, haze;
void main() {
    vec4 s = texture(sprites, v_uv);
    if (s.a < 0.5) discard;
    vec3 col = v_em > 0.5 ? s.rgb : s.rgb * sprite_k;
    float f = clamp((-v_ry - 90.0) / 170.0, 0.0, 1.0) * 0.78;
    col = col * (1.0 - f) + haze * f;
    o_col = vec4(col, 1); o_em = vec4(0); o_z = vec4(v_dz, 0, 0, 1);
}
`;

// particles (dio.splat): squares of 2r engine pixels, depth-tested, glow into the bloom
export const SPLAT_VS = HEAD + `
in vec3 position; in vec3 aColor; in vec2 aSize;
uniform float res;
out vec3 v_c; out float v_glow; out float v_dz;
` + COMMON + `
void main() {
    float dz;
    vec4 cp = project(position, dz);
    cp.z = -(dz + 1.0) / 30000.0 * cp.w;
    gl_Position = cp;
    gl_PointSize = 2.0 * max(1.0, floor(cam_zoom * aSize.x * 0.5 + 0.5)) * res;
    v_c = aColor; v_glow = aSize.y; v_dz = dz;
}
`;
export const SPLAT_FS = HEAD + `
in vec3 v_c; in float v_glow; in float v_dz;
layout(location = 0) out vec4 o_col; layout(location = 1) out vec4 o_em; layout(location = 2) out vec4 o_z;
void main() { o_col = vec4(v_c, 1); o_em = vec4(v_c * v_glow, 1); o_z = vec4(v_dz, 0, 0, 1); }
`;

// ---- post: distance fog, then occlusion from the depth buffer and the two-radius bloom
export const FOG_FS = HEAD + `
uniform sampler2D t_col, t_em, t_z; uniform float persp, sa, stars; uniform vec3 FOG; uniform int style;
layout(location = 0) out vec4 o_img; layout(location = 1) out vec4 o_ez; layout(location = 2) out vec4 o_sky;
void main() {
    ivec2 ij = ivec2(gl_FragCoord.xy);
    vec3 img = texelFetch(t_col, ij, 0).rgb, em = texelFetch(t_em, ij, 0).rgb;
    float zb = texelFetch(t_z, ij, 0).r;
    bool sky = zb < -1e8;
    if (persp > 0.0) {
        float d0 = 160.0, d1 = 420.0, top = 0.9;
        if (style == 1 && stars <= 0.5) { d0 = 150.0; d1 = 430.0; top = 1.0; }
        float far = max(-(sky ? 0.0 : zb) / sa, 0.0);
        float f = clamp((far - d0) / d1, 0.0, 1.0) * top * persp * (sky ? 0.0 : 1.0);
        img = img * (1.0 - f) + FOG * f; em *= 1.0 - f;
    }
    float z = style == 1 ? max(sky ? -1e4 : zb, -450.0) : max(zb, -600.0);
    o_img = vec4(img, sky ? 0.0 : 1.0);
    o_ez = vec4(em, z);
    o_sky = vec4(sky ? 1.0 : 0.0, 0, 0, 1);
}
`;
export const BOX_FS = HEAD + `
uniform sampler2D src; uniform vec2 dir; uniform int r;
out vec4 o;
void main() {
    ivec2 ij = ivec2(gl_FragCoord.xy), sz = textureSize(src, 0) - 1;
    ivec2 d = ivec2(dir);
    vec4 s = vec4(0.0);
    for (int k = -64; k <= 64; k++) {
        if (k < -r || k > r) continue;
        s += texelFetch(src, clamp(ij + d * k, ivec2(0), sz), 0);
    }
    o = s / float(2 * r + 1);
}
`;
export const COMPOSE_FS = HEAD + `
uniform sampler2D t_img, t_ez, t_b3, t_b10, t_sky3; uniform int style; uniform float stars;
out vec4 o;
void main() {
    ivec2 ij = ivec2(gl_FragCoord.xy);
    vec4 im = texelFetch(t_img, ij, 0), ez = texelFetch(t_ez, ij, 0), b3 = texelFetch(t_b3, ij, 0), b10 = texelFetch(t_b10, ij, 0);
    float occl, ok = im.a;
    if (style == 1) {                                  // day3.post: creases only, none against the sky
        float gap = b3.a - ez.a;
        float fade = clamp((ez.a + 450.0) / 150.0, 0.0, 1.0);
        float near_sky = texelFetch(t_sky3, ij, 0).r > 0.02 ? 0.0 : 1.0;
        occl = clamp(gap / 5.0, 0.0, 1.0) * (gap < 30.0 ? 1.0 : 0.0) * fade * ok * near_sky * stars;
    } else {
        occl = clamp((b3.a - ez.a) / 5.0, 0.0, 1.0) * ok;
    }
    vec3 img = im.rgb * (1.0 - 0.5 * occl) + b3.rgb * 0.9 + b10.rgb * 0.75;
    o = vec4(pow(clamp(img, 0.0, 1.0), vec3(0.95)), 1.0);
}
`;
