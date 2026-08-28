/**
 * The page an OAuth provider redirects back to, for every authorization this
 * product runs (MCP servers and inference providers alike).
 *
 * It is the only web surface the product has and the last thing an operator
 * sees before returning to the terminal, so it carries the brand rather than a
 * browser's default serif on white: the mark animates through the same
 * dithered draw/fill timeline as the boot screen and the TUI landing
 * (`tui/mark-anim.ts`), which is the canvas original the terminal
 * approximates rather than a second interpretation of it.
 *
 * Everything is inline. The loopback server has no asset route, and a page
 * that reached out to a CDN would be a network call made by a local
 * authorization callback.
 */

import {
  PRODUCT_GITHUB_LABEL,
  PRODUCT_GITHUB_URL,
  PRODUCT_NAME,
  PRODUCT_SITE_LABEL,
  PRODUCT_SITE_URL,
} from "../branding.js";

/** Corbits wordmark, background layers stripped so it inherits `currentColor`. */
const WORDMARK = `<svg class="wordmark" viewBox="0 0 1000 400" role="img" aria-label="Corbits" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M195.057 192.125L160.182 225.625C157.016 214.042 153.099 205.042 148.432 198.625C143.849 192.208 138.974 189 133.807 189C129.724 189 126.557 190.75 124.307 194.25C122.141 197.75 121.057 202.75 121.057 209.25C121.057 224.583 124.307 237.167 130.807 247C137.307 256.833 145.641 261.75 155.807 261.75C161.391 261.75 166.682 260.333 171.682 257.5C176.766 254.667 181.141 250.708 184.807 245.625L196.557 254.25C189.807 268.667 181.266 279.667 170.932 287.25C160.599 294.833 149.016 298.625 136.182 298.625C120.016 298.625 106.724 293.083 96.3072 282C85.9739 270.833 80.8072 256.667 80.8072 239.5C80.8072 219.583 87.7239 202.333 101.557 187.75C115.391 173.083 131.349 165.75 149.432 165.75C158.682 165.75 167.182 168 174.932 172.5C182.682 177 189.391 183.542 195.057 192.125ZM303.705 248.125C303.705 231.292 300.288 216.542 293.455 203.875C286.705 191.208 279.371 184.875 271.455 184.875C266.371 184.875 262.413 187.458 259.58 192.625C256.746 197.792 255.33 205.125 255.33 214.625C255.33 232.208 258.621 247.417 265.205 260.25C271.788 273 279.08 279.375 287.08 279.375C292.496 279.375 296.621 276.75 299.455 271.5C302.288 266.167 303.705 258.375 303.705 248.125ZM279.705 165.75C300.038 165.75 316.913 172.042 330.33 184.625C343.83 197.208 350.58 213.083 350.58 232.25C350.58 251.417 343.871 267.292 330.455 279.875C317.121 292.375 300.205 298.625 279.705 298.625C259.121 298.625 242.08 292.375 228.58 279.875C215.163 267.375 208.455 251.5 208.455 232.25C208.455 213 215.163 197.125 228.58 184.625C242.08 172.042 259.121 165.75 279.705 165.75ZM464.727 164.5L478.352 169.25L463.227 212C458.311 210.083 454.144 208.667 450.727 207.75C447.394 206.833 444.561 206.375 442.227 206.375C437.144 206.375 433.144 208.125 430.227 211.625C427.311 215.042 425.852 219.792 425.852 225.875V279.125H438.852V295H371.352V279.125H380.227V214.875C380.227 211.542 379.936 209.292 379.352 208.125C378.769 206.958 377.686 205.875 376.102 204.875L371.352 208.75L362.102 198.5L389.727 165.75C397.477 169.333 403.602 173.208 408.102 177.375C412.686 181.542 415.936 186.292 417.852 191.625C425.102 180.542 430.477 173.458 433.977 170.375C437.561 167.292 441.311 165.75 445.227 165.75C447.394 165.75 449.894 166.167 452.727 167C455.644 167.75 458.727 168.875 461.977 170.375L464.727 164.5ZM540.875 248.875C540.875 257.292 542.417 263.75 545.5 268.25C548.583 272.75 552.958 275 558.625 275C564.625 275 569.375 272.25 572.875 266.75C576.458 261.25 578.25 253.667 578.25 244C578.25 229.75 575.75 218.125 570.75 209.125C565.833 200.125 559.542 195.625 551.875 195.625C550.125 195.625 548.417 195.917 546.75 196.5C545.083 197 543.125 197.917 540.875 199.25V248.875ZM550.375 118.375V134.5L540.875 137.5V181.875C548.792 176.208 555.75 172.125 561.75 169.625C567.75 167.042 573.417 165.75 578.75 165.75C590.667 165.75 600.542 170.417 608.375 179.75C616.292 189.083 620.25 200.792 620.25 214.875C620.25 226.458 617.958 237.417 613.375 247.75C608.875 258 602.208 267.25 593.375 275.5C585.458 283.083 576.958 288.833 567.875 292.75C558.792 296.667 549.375 298.625 539.625 298.625C532.208 298.625 524.458 297.333 516.375 294.75C508.292 292.083 501.208 288.583 495.125 284.25V152.125L486.375 155V138.875L550.375 118.375ZM694.898 165.75H696.648C696.231 171.167 695.898 175.625 695.648 179.125C695.481 182.542 695.398 185.417 695.398 187.75V279.125H704.273V295H640.898V279.125H649.773V193.375L640.898 194.875V180.625L694.898 165.75ZM677.148 126C683.231 126 688.106 127.417 691.773 130.25C695.523 133.083 697.398 136.708 697.398 141.125C697.398 147.125 694.314 152.25 688.148 156.5C682.064 160.75 674.731 162.875 666.148 162.875C660.898 162.875 656.689 161.542 653.523 158.875C650.356 156.208 648.773 152.667 648.773 148.25C648.773 142.5 651.648 137.375 657.398 132.875C663.148 128.292 669.731 126 677.148 126ZM771.67 137.25L784.545 140.125V170.625H806.795L804.17 185.375C803.837 187.875 803.42 189.417 802.92 190C802.42 190.5 801.587 190.75 800.42 190.75H784.545V255.375C784.545 261.792 785.378 266.333 787.045 269C788.712 271.667 791.545 273 795.545 273C797.045 273 798.628 272.708 800.295 272.125C802.045 271.542 803.962 270.625 806.045 269.375L812.67 279.125C806.503 285.458 799.92 290.292 792.92 293.625C785.92 296.958 778.92 298.625 771.92 298.625C760.253 298.625 751.795 295.875 746.545 290.375C741.295 284.792 738.67 275.75 738.67 263.25V190.75H726.92V176.25C738.253 172.917 747.628 168 755.045 161.5C762.545 155 768.087 146.917 771.67 137.25ZM916.693 179.75L898.068 209.25C890.818 200.667 884.401 194.333 878.818 190.25C873.318 186.167 868.401 184.125 864.068 184.125C861.651 184.125 859.693 184.833 858.193 186.25C856.776 187.583 856.068 189.375 856.068 191.625C856.068 194.292 857.443 196.875 860.193 199.375C863.026 201.875 868.651 205.25 877.068 209.5C895.651 218.833 907.484 226.417 912.568 232.25C917.734 238.083 920.318 245.083 920.318 253.25C920.318 265.833 914.984 276.542 904.318 285.375C893.734 294.208 880.568 298.625 864.818 298.625C855.484 298.625 846.568 297.125 838.068 294.125C829.651 291.042 821.651 286.458 814.068 280.375L835.068 247.875C844.151 257.875 852.276 265.417 859.443 270.5C866.609 275.583 872.651 278.125 877.568 278.125C880.401 278.125 882.568 277.458 884.068 276.125C885.568 274.708 886.318 272.708 886.318 270.125C886.318 265.708 878.693 259.458 863.443 251.375L863.318 251.25C862.401 250.75 861.151 250.083 859.568 249.25C836.734 236.917 825.318 223.333 825.318 208.5C825.318 195.833 829.734 185.542 838.568 177.625C847.484 169.708 859.193 165.75 873.693 165.75C881.276 165.75 888.609 166.917 895.693 169.25C902.776 171.583 909.776 175.083 916.693 179.75Z" fill="currentColor"/> </svg>`;

/** The mark silhouette, as authored (viewBox 0 0 500 500). */
const MARK_PATH =
  "M392.899 189.107L397.586 197.031C397.586 197.031 399.539 202.891 399.539 204.844L403.094 222.422C407 222.813 407.39 226.328 409.734 227.109C412.078 228.281 415.203 231.797 416.765 235.313C417.156 236.875 418.718 240.781 420.671 244.688C422.234 247.422 422.625 250.156 424.578 251.719L426.921 254.062C432.39 258.359 432.781 261.484 433.171 272.422C432.781 280.625 434.734 295.078 435.906 301.328C436.296 302.891 436.296 302.891 437.468 303.281C438.25 304.063 437.078 302.891 437.859 303.281C439.031 304.063 443.328 304.844 449.187 307.188C451.921 307.969 454.265 309.141 455.046 313.828C456.609 320.469 464.421 350.938 467.156 369.688L468.328 385.313L447.977 371.026C443.68 353.057 435.867 327.667 433.914 323.76C431.57 321.026 423.758 320.245 419.461 319.463C416.336 319.073 413.992 317.12 412.43 312.042C412.43 308.135 411.649 301.495 410.086 292.51C408.914 285.088 408.914 281.182 408.914 277.276C408.914 272.198 406.57 270.245 400.32 263.995L397.977 259.307C391.336 246.807 390.945 244.854 387.039 244.073C385.376 244.024 384.994 238.473 383.562 235.313C383.562 234.141 384.734 231.016 383.562 225.156L368.288 212.656C361.648 212.266 357.352 225.825 353.445 232.466L348.367 244.966L342.899 261.372L341.727 263.326L340.555 266.06L330.008 281.294L326.102 287.544L324.93 289.107L317.117 299.263L308.524 309.029L291.727 327.779L287.039 334.029L284.305 335.982L270.242 352.779L267.508 355.513L265.555 358.638L264.383 359.81L256.18 368.404L248.367 375.044L246.805 376.607L241.336 380.904C238.602 384.029 231.57 384.531 228.055 384.531C225.71 382.578 216.248 381.938 217.508 379.62L226.883 372.588L228.836 371.026L234.695 364.776L237.039 362.432L242.508 357.354C247.195 352.667 251.102 349.151 253.055 340.948C254.227 336.651 264.383 326.104 268.289 321.807L269.07 321.417L295.242 293.682L315.273 261.372L318.397 253.56C320.35 249.654 320.741 247.086 321.522 244.464C322.013 242.815 326.6 216.563 324.93 212.656C323.26 208.75 332.088 195.551 326.209 189.721C323.866 187.768 320.35 185.815 318.397 183.862C313.507 178.972 300.038 175.659 301.6 169.409L300.711 159.81C303.445 148.482 306.57 135.982 303.445 135.982C301.492 135.982 290.945 149.654 286.258 155.513L285.086 156.685C276.883 168.013 266.336 177.779 258.133 191.841L242.899 218.404L237.039 226.997C235.476 228.281 229.617 232.188 227.663 232.188C221.804 228.281 222.586 225.825 217.508 234.419L203.055 260.201L201.492 264.107L200.711 265.279L197.977 270.357L196.414 273.872L182.742 296.919L173.758 314.107L170.242 319.185L168.68 321.919L167.117 323.984L163.992 327.779C163.958 327.968 156.476 332.069 155.399 331.797C154.321 331.525 148.835 329.953 147.586 327.779C146.337 325.605 148.281 323.835 149.149 322.7C154.227 316.06 153.445 310.313 153.445 308.359C153.445 306.406 151.492 298.594 151.492 296.641C151.492 294.688 151.102 294.688 151.492 284.922C152.274 273.594 143.289 274.654 144.852 265.279C145.633 259.029 146.414 251.216 143.289 253.56C141.727 253.56 129.617 266.841 124.149 273.482L114.774 285.982L99.5392 305.122L96.0236 308.247L90.5548 313.716L87.4298 315.669C84.6954 319.966 77.2736 323.091 73.3673 329.732L67.1173 340.279L64.7736 344.966L61.6486 349.654L60.4767 350.826L57.7423 355.513L55.3986 358.247L42.1173 375.826L35.0861 383.247C33.7739 384.117 33.1434 384.48 32.3517 384.531C31.5599 384.582 32.3525 374.383 32.3525 374.383L33.1329 370.859L33.9142 369.185C36.6486 363.325 41.3361 357.076 46.0236 350.826C51.1017 343.404 57.3517 329.732 63.6017 320.747L68.6798 316.06L75.3204 308.247C78.0548 306.294 81.9611 301.997 86.2579 296.529L87.8204 295.357L94.8517 286.763C100.711 278.56 116.727 261.372 126.492 251.997L128.055 249.766L130.789 247.31C137.43 241.451 143.68 233.247 148.758 233.247C156.961 233.638 162.43 240.279 167.117 244.966L184.305 261.372C185.867 262.935 187.43 262.154 188.211 260.591C200.32 237.935 210.867 216.841 219.461 216.06H226.492L229.617 213.716C236.258 202.779 244.07 187.935 250.711 178.169C258.524 167.622 283.914 134.81 298.758 121.138C302.274 117.232 305.008 115.781 307.742 115C311.649 115 315.555 116.841 319.07 119.575C333.524 131.685 356.961 157.857 366.336 168.404L372.195 173.091L387.039 181.294L390.556 185.313L392.899 189.107Z";

// Brand palette, dark-first with the light scheme as the media override.
// Backgrounds are black/white; element neutrals are cream on dark and charcoal
// on light, and never cross over.
// The terminal palette, not the print one: the charcoal ground and the stepped
// creams are `tui/theme.ts` verbatim, so the tab an operator lands on
// and the terminal they came from are the same surface.
const STYLE = `
:root {
  color-scheme: dark light;
  --bg: #191614;
  --ink: #f7ead5;
  --ink-dim: #a89f91;
  --ink-faint: #787166;
  --rule: #3a332c;
  --accent: #e98428;
  --accent-dim: #bf6b20;
  --ok: #7b9974;
  --gap: 4rem;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --ink: #2b2627;
    --ink-dim: #5c5555;
    --ink-faint: #8a827f;
    --rule: #e2dad0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 3rem;
  background: var(--bg);
  color: var(--ink);
  font-family: "Red Hat Display", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: var(--gap);
  max-width: 56rem;
  animation: rise 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
canvas { width: 22rem; height: 15rem; display: block; }
/* One left edge for the whole column: every row starts on it, and the rule
   and the wordmark end on the same right edge. */
.detail { display: grid; justify-items: start; gap: 0; max-width: 26rem; }
.wordmark { width: 9rem; height: auto; color: var(--ink); }
.status {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 1.75rem 0 0;
  font-family: "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--tone); }
h1 {
  margin: 0.875rem 0 0;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
p.body { margin: 0.875rem 0 0; color: var(--ink-dim); line-height: 1.65; }
hr { width: 100%; margin: 2rem 0 0; border: 0; border-top: 1px solid var(--rule); }
footer {
  margin-top: 0.875rem;
  font-family: "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.75rem;
}
footer a {
  color: var(--ink-dim);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}
footer a:hover {
  color: var(--ink);
  border-bottom-color: var(--rule);
}
footer .sep { color: var(--rule); }
@keyframes rise {
  from { opacity: 0; transform: translateY(0.5rem); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  main { animation: none; }
}
@media (max-width: 46rem) {
  main { grid-template-columns: 1fr; gap: 2rem; justify-items: start; }
  canvas { width: 100%; max-width: 22rem; }
}
`;

/**
 * The mark, dithered. An offscreen fill of the path is the coverage mask; each
 * 4px cell then thresholds a travelling sine against an ordered Bayer matrix,
 * so the body shades in steps rather than gradients — the same trade the
 * terminal makes with block characters, made in pixels.
 *
 * The timeline matches `markFrame`: draw left to right, hold, fill bottom-up,
 * hold, fade, loop. Reduced motion resolves to the still, filled mark.
 */
const SCRIPT = `
const CELL = 4;
const PERIOD = 4.6;
const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const path = new Path2D(canvas.dataset.path);
let cols = 0, rows = 0, mask = null;

const smooth = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };

function frame(seconds) {
  if (still) return { draw: 1, fill: 1, alpha: 1 };
  const p = ((seconds % PERIOD) + PERIOD) % PERIOD / PERIOD;
  if (p < 0.38) return { draw: smooth(p / 0.38), fill: 0, alpha: 1 };
  if (p < 0.48) return { draw: 1, fill: 0, alpha: 1 };
  if (p < 0.76) return { draw: 1, fill: smooth((p - 0.48) / 0.28), alpha: 1 };
  if (p < 0.9) return { draw: 1, fill: 1, alpha: 1 };
  return { draw: 1, fill: 1, alpha: smooth((1 - p) / 0.1) };
}

// Coverage per cell, sampled once per size: fill the path into a buffer one
// pixel per cell and read back its alpha.
function measure() {
  const box = canvas.getBoundingClientRect();
  canvas.width = Math.round(box.width);
  canvas.height = Math.round(box.height);
  cols = Math.ceil(canvas.width / CELL);
  rows = Math.ceil(canvas.height / CELL);
  const buffer = document.createElement("canvas");
  buffer.width = cols;
  buffer.height = rows;
  const bctx = buffer.getContext("2d");
  // 92% centred fit of the mark's own bounds inside the cell grid.
  const scale = Math.min(cols / 500, rows / 500) * (500 / 437) * 0.92;
  bctx.translate((cols - 437 * scale) / 2 - 32 * scale, (rows - 270 * scale) / 2 - 115 * scale);
  bctx.scale(scale, scale);
  bctx.fillStyle = "#fff";
  bctx.fill(path);
  mask = bctx.getImageData(0, 0, cols, rows).data;
}

function paint(nowMs) {
  const { draw, fill, alpha } = frame(nowMs / 1000);
  const ink = getComputedStyle(canvas).getPropertyValue("--accent").trim();
  const revealed = draw * cols;
  const fillLine = rows * (1 - fill);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink;
  for (let row = 0; row < rows; row++) {
    // 1 once the row is wholly below the fill line, 0 once wholly above it.
    const rowFill = Math.min(1, Math.max(0, row + 1 - fillLine));
    for (let col = 0; col < cols; col++) {
      if (col >= revealed) break;
      const coverage = mask[(row * cols + col) * 4 + 3] / 255;
      if (coverage === 0) continue;
      // A travelling sine gives the body its shimmer; the edge of the reveal
      // and the fill line ride the same ramp so neither lands as a hard cut.
      const wave = 0.5 + 0.5 * Math.sin(col * 0.18 - nowMs / 520 + row * 0.12);
      const edge = Math.min(1, revealed - col);
      const value = coverage * alpha * edge * (0.45 + 0.55 * rowFill) * (0.55 + 0.45 * wave);
      if (value * 16 <= BAYER[(row % 4) * 4 + (col % 4)]) continue;
      ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
    }
  }
}

function loop(nowMs) {
  paint(nowMs);
  if (!still) requestAnimationFrame(loop);
}

measure();
requestAnimationFrame(loop);
window.addEventListener("resize", () => { measure(); if (still) paint(0); });
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Server names and OAuth error codes both arrive as machine identifiers
 * (`granola`, `claude_ai_Gamma`, `access_denied`). Nothing on this page is
 * addressed to a machine, so the underscores and hyphens come out and the
 * first word is capitalized.
 */
export function humanizeIdentifier(raw: string): string {
  const words = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (words.length === 0) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A footer link, preceded by its separator.
 *
 * Opens in a new tab so the operator keeps the tab telling them the
 * authorization finished and this window is safe to close.
 */
function footerLink(url: string, label: string): string {
  return `<span class="sep" aria-hidden="true">·</span><a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export interface CallbackPage {
  /** What was being authorized: an MCP server or provider name. */
  readonly subject?: string;
  /** Why it failed. Omit for the success page. */
  readonly error?: string;
  /** Authorization succeeded, but the native setup flow still has work to do. */
  readonly pendingSetup?: boolean;
}

/**
 * Render the callback page.
 *
 * The subject leads the headline rather than sitting in a subclause: an
 * operator authorizing several servers ends up with several of these tabs
 * open, and the one thing each has to answer is which server it is and
 * whether that one worked.
 */
export function callbackPageHtml(page: CallbackPage = {}): string {
  const failed = page.error !== undefined;
  const subject =
    page.subject === undefined ? undefined : escapeHtml(humanizeIdentifier(page.subject));
  const pendingSetup = !failed && page.pendingSetup === true;
  const tone = failed ? "var(--accent)" : "var(--ok)";
  const label = failed ? "not connected" : pendingSetup ? "authorization received" : "connected";
  const heading = failed
    ? subject === undefined
      ? "Authorization did not complete"
      : `${subject} failed to connect`
    : pendingSetup
      ? subject === undefined
        ? "Authorization received"
        : `${subject} authorization received`
      : subject === undefined
        ? "Authorization complete"
        : `${subject} connected successfully`;
  const reason = escapeHtml(humanizeIdentifier(page.error ?? ""));
  const body = failed
    ? `${reason}. Close this tab and try again from ${PRODUCT_NAME}.`
    : pendingSetup
      ? `Return to ${PRODUCT_NAME} to finish setup.`
      : `You can close this tab and return to ${PRODUCT_NAME}.`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(heading)} \u00b7 ${PRODUCT_NAME}</title>`,
    `<style>${STYLE}</style>`,
    "<body><main>",
    `<canvas aria-hidden="true" data-path="${MARK_PATH}"></canvas>`,
    '<div class="detail">',
    WORDMARK,
    `<p class="status" style="--tone:${tone}"><span class="dot"></span>${label}</p>`,
    `<h1>${heading}</h1>`,
    `<p class="body">${body}</p>`,
    "<hr>",
    `<footer>${PRODUCT_NAME}${footerLink(PRODUCT_SITE_URL, PRODUCT_SITE_LABEL)}${footerLink(PRODUCT_GITHUB_URL, PRODUCT_GITHUB_LABEL)}</footer>`,
    "</div>",
    "</main></body>",
    `<script>${SCRIPT}</script>`,
    "</html>",
  ].join("");
}
