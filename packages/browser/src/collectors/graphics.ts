/**
 * WebGL renderer tells (spec §1). Software rasterisers in the wild
 * (cdp-leak-techniques.md §9.4):
 *   "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"  (x86 Linux)
 *   "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)" (arm64)
 *   "Google SwiftShader", "llvmpipe" (Mesa software), BotD legacy vendor "Brian Paul" + "Mesa OffScreen",
 *   "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)" (Windows VMs).
 * Guards (false-positive-traps.md §5, §7.1): VDI/RDP and GPU-blocklisted machines also run software GL
 * (family-capped); Brave >= 1.93 returns one generic vendor/renderer string for everyone, which is not
 * software GL and must not fire.
 */
import type { EnvWebGL } from './env.js';
import type { Finding } from './finding.js';
import type { ParsedUA } from './ua.js';

export const SOFTWARE_GL = /SwiftShader|llvmpipe|Mesa OffScreen|Software|ANGLE \(Google, Vulkan 1\.\d+\.\d+ \(SwiftShader/i;
const WINDOWS_VM_GL = /Microsoft Basic Render Driver/i;
const BOTD_LEGACY_VENDOR = /Brian Paul/i;

export interface GraphicsInput {
  ua: ParsedUA;
  webgl: EnvWebGL | null | undefined;
  brave: boolean;
}

export function analyzeGraphics(i: GraphicsInput): Finding[] {
  const out: Finding[] = [];
  if (i.webgl === undefined) return out; // could not test
  if (i.brave) return out; // generic strings for every Brave user; nothing to learn here

  if (i.webgl === null) {
    // Chrome 155 with --disable-gpu (common Docker recipes, Puppeteer) has no WebGL context at all unless
    // --enable-unsafe-swiftshader is passed. Firefox users can disable WebGL by preference: weaker there.
    if (i.ua.desktop && i.ua.engine === 'blink') {
      out.push({
        id: 'env.software-gpu',
        summary: `no WebGL context on a desktop ${i.ua.browser} UA (GPU disabled)`,
        value: null,
        reliability: 0.7,
        privacyGated: true,
      });
    }
    return out;
  }

  const { vendor, renderer } = i.webgl;
  if (SOFTWARE_GL.test(renderer) || BOTD_LEGACY_VENDOR.test(vendor)) {
    out.push({
      id: 'env.software-gpu',
      summary: `WebGL renderer "${renderer}" is a software rasteriser (vendor "${vendor}")`,
      value: renderer,
      details: { vendor, unmasked: i.webgl.unmasked },
      privacyGated: true,
    });
  } else if (WINDOWS_VM_GL.test(renderer)) {
    out.push({
      id: 'env.software-gpu',
      summary: `WebGL renderer "${renderer}" is the Windows VM basic render driver`,
      value: renderer,
      details: { vendor, unmasked: i.webgl.unmasked },
      reliability: 0.7,
      privacyGated: true,
    });
  }
  return out;
}

export type GpuFamily = 'apple' | 'direct3d' | 'mesa-linux' | 'mobile' | 'software' | 'generic' | 'unknown';

/** Which OS family a renderer string implies; 'generic'/'software' carry no platform information. */
export function gpuFamily(webgl: EnvWebGL | null | undefined): GpuFamily {
  if (!webgl) return 'unknown';
  const r = webgl.renderer;
  if (SOFTWARE_GL.test(r) || WINDOWS_VM_GL.test(r)) return 'software';
  if (/Apple/i.test(r) || /Apple/i.test(webgl.vendor)) return 'apple';
  if (/Direct3D|D3D11|D3D9/i.test(r)) return 'direct3d';
  if (/Mesa|llvmpipe|radeonsi|nouveau|\(Intel\)|Intel\(R\).*(Graphics)\s*\(/i.test(r) && !/Direct3D|Metal|OpenGL Engine/i.test(r)) return 'mesa-linux';
  if (/Adreno|Mali|PowerVR|Immortalis|Xclipse|Tegra/i.test(r)) return 'mobile';
  if (!webgl.unmasked || /^WebKit/i.test(r) || r === '' ) return 'generic';
  return 'unknown';
}
