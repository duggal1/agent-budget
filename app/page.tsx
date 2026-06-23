// components/footer.tsx
'use client'

import { useCallback, useEffect, useRef } from 'react'
import gsap from 'gsap'

// ─── constants ────────────────────────────────────────────────────────────────

const ROWS = 14
const COLS = { desktop: 52, tablet: 24, mobile: 22 } as const
type Mode = keyof typeof COLS

const PATTERNS: readonly string[][] = [
  [
    '------------------','------------------','------------------',
    '--------11--------','-----1--11--1-----','----111-11-111----',
    '-----11----11-----','------------------','---111------111---',
    '---111------111---','------------------','-----11----11-----',
    '----111-11-111----','-----1--11--1-----','--------11--------',
    '------------------','------------------','------------------',
  ],
  [
    '------------------','------------------','------------------',
    '------------------','------11--11------','----1111111111----',
    '---111111111111---','---111111111111---','---111111111111---',
    '----1111111111----','-----11111111-----','------111111------',
    '-------1111-------','--------11--------','------------------',
    '------------------','------------------','------------------',
  ],
  [
    '------------------','------------------','------------------',
    '--------1---------','--------11--------','--------11--------',
    '-------1111-------','------111111------','----1111--11111---',
    '---11111--1111----','------111111------','-------1111-------',
    '--------11--------','--------11--------','---------1--------',
    '------------------','------------------','------------------',
  ],
  [
    '------------------','------------------','------------------',
    '-------1111-------','------111111------','-----11111111-----',
    '-----11111111-----','-----11111111-----','------111111------',
    '-------1111-------','------111111------','-----111--111-----',
    '----11------11----','----11------11----','----1--------1----',
    '------------------','------------------','------------------',
  ],
] as const

const CLOUD_RADIUS = 12
const ANIM_DUR     = 1      // s per transition
const HOLD_DUR     = 1      // s to hold each pattern
const N_GROUPS     = 20
const CHAOS        = 0.35
const DIM          = 0.15

// ─── pure helpers (module-level = stable refs in useCallback) ─────────────────

function detectMode(): Mode {
  if (window.innerWidth >= 992) return 'desktop'
  if (window.innerWidth >= 768) return 'tablet'
  return 'mobile'
}

function shuffleGrouped<T>(arr: T[], n: number): T[][] {
  const s    = [...arr].sort(() => Math.random() - 0.5)
  const size = Math.ceil(s.length / n)
  return Array.from({ length: n }, (_, i) => s.slice(i * size, (i + 1) * size))
}

function stagger(dots: HTMLDivElement[], opacityFor: (d: HTMLDivElement) => number) {
  const sg = ANIM_DUR / N_GROUPS
  const si = sg / 4
  shuffleGrouped(dots, N_GROUPS).forEach((grp, gi) =>
    grp.forEach(d =>
      gsap.to(d, {
        opacity:  opacityFor(d),
        duration: ANIM_DUR,
        delay:    gi * sg + Math.random() * si,
        ease:     'steps(2)',
      }),
    ),
  )
}

// ─── DotGrid ──────────────────────────────────────────────────────────────────

function DotGrid() {
  const wrapRef    = useRef<HTMLDivElement>(null)
  const dotsRef    = useRef<HTMLDivElement[]>([])
  const modeRef    = useRef<Mode | null>(null)
  const patternIdx = useRef(0)
  const tids       = useRef<ReturnType<typeof setTimeout>[]>([])

  const flush = () => { tids.current.forEach(clearTimeout); tids.current = [] }
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms)
    tids.current.push(t)
  }

  const build = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const m = detectMode()
    if (m === modeRef.current) return
    modeRef.current = m

    gsap.killTweensOf(dotsRef.current)
    el.innerHTML   = ''
    dotsRef.current = []

    const cols = COLS[m]
    const size = m === 'mobile' ? '8px' : '16px'
    el.style.gridTemplateColumns = `repeat(${cols}, ${size})`
    el.style.gap = size

    for (let i = 0; i < cols * ROWS; i++) {
      const d     = document.createElement('div')
      d.dataset.c = String(i % cols)
      d.dataset.r = String(Math.floor(i / cols))
      d.style.cssText =
        `width:${size};height:${size};border-radius:9999px;` +
        `background:currentColor;opacity:${DIM};will-change:opacity;`
      el.appendChild(d)
      dotsRef.current.push(d)
    }
  }, [])

  // stable because deps are refs, module constants, or the module-level stagger fn
  const showCloud = useCallback(() => {
    const cols = COLS[modeRef.current ?? 'desktop']
    const cx   = Math.floor(cols / 2)
    const cy   = Math.floor(ROWS / 2)
    stagger(dotsRef.current, d => {
      const dist = Math.hypot(+d.dataset.c! - cx, +d.dataset.r! - cy)
      const core = Math.max(0, 1 - dist / CLOUD_RADIUS)
      return Math.min(1, Math.max(DIM, DIM + core * 0.7 + (Math.random() - 0.5) * CHAOS))
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const showPattern = useCallback((idx: number) => {
    const cols = COLS[modeRef.current ?? 'desktop']
    const cx   = Math.floor(cols / 2)
    const cy   = Math.floor(ROWS / 2)
    const lit  = new Set<string>()
    PATTERNS[idx].forEach((row, r) =>
      [...row].forEach((ch, c) => { if (ch === '1') lit.add(`${cx - 9 + c},${cy - 9 + r}`) }),
    )
    stagger(dotsRef.current, d => (lit.has(`${d.dataset.c},${d.dataset.r}`) ? 1 : DIM))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const cycle = useCallback(() => {
    showPattern(patternIdx.current)
    later(() => {
      patternIdx.current = (patternIdx.current + 1) % PATTERNS.length
      showCloud()
      later(cycle, ANIM_DUR * 1000)
    }, (ANIM_DUR + HOLD_DUR) * 1000)
  }, [showPattern, showCloud]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    build()
    showCloud()
    later(cycle, ANIM_DUR * 1000)

    const onResize = () => {
      flush()
      build()
      showCloud()
      later(cycle, ANIM_DUR * 1000)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      flush()
      gsap.killTweensOf(dotsRef.current)
    }
  }, [build, showCloud, cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={wrapRef}
      style={{ display: 'grid', pointerEvents: 'none' }}
    />
  )
}

// ─── sub-components ───────────────────────────────────────────────────────────

type AProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { children: React.ReactNode }

const NavLink = ({ children, ...rest }: AProps) => (
  <a {...rest} className="text-lg font-medium leading-none transition-opacity duration-150 hover:opacity-40">
    {children}
  </a>
)

const MetaLink = ({ children, ...rest }: AProps) => (
  <a {...rest} className="text-sm text-black/40 transition-colors duration-150 hover:text-black">
    {children}
  </a>
)

// ─── Footer ───────────────────────────────────────────────────────────────────

export default function Footer() {
  return (
    <footer className="relative overflow-hidden bg-white text-black">

      {/* ── content ── */}
      <div className="mx-auto max-w-7xl px-6 py-20 lg:px-12">

        {/* top */}
        <div className="flex flex-col gap-16 lg:flex-row lg:justify-between">

          {/* logo */}
          <a href="/" className="flex shrink-0 items-center gap-3">
            <svg width="40" height="38" viewBox="0 0 68 64" fill="none">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M68.1289 17.2717C68.1289 18.1895 67.3848 18.9336 66.467
                   18.9336H36.5574C35.6396 18.9336 34.8955 19.6777 34.8955
                   20.5955V24.4972C34.8955 25.4151 35.6396 26.1592 36.5574
                   26.1592H62.3381C63.2559 26.1592 64 26.9033 64
                   27.8211V43.1779C64 44.0958 63.2559 44.8398 62.3381
                   44.8398H28.6932C27.7753 44.8398 27.0312 45.5839 27.0312
                   46.5018V62.3381C27.0312 63.2559 26.2872 64 25.3693
                   64H1.66194C0.744075 64 0 63.2559 0 62.3381V27.5399C0
                   26.622 0.744076 25.8779 1.66194 25.8779H10.717C11.6348
                   25.8779 12.3789 25.1339 12.3789 24.216V20.8299C12.3789
                   19.912 11.6348 19.168 10.717 19.168H1.66194C0.744075
                   19.168 0 18.4239 0 17.506V1.66194C0 0.744076 0.744076 0
                   1.66194 0H66.467C67.3848 0 68.1289 0.744076 68.1289
                   1.66194V17.2717ZM21.6776 33.6328C20.7597 33.6328 20.0156
                   34.3769 20.0156 35.2948V40.2179C20.0156 41.1358 20.7597
                   41.8799 21.6776 41.8799H25.4181C26.336 41.8799 27.0801
                   41.1358 27.0801 40.2179V35.2948C27.0801 34.3769 26.336
                   33.6328 25.4181 33.6328H21.6776Z"
                fill="currentColor"
              />
            </svg>
            <span className="text-xl font-semibold tracking-tight">fourmula.ai</span>
          </a>

          {/* nav */}
          <div className="grid grid-cols-2 gap-x-20 gap-y-10 lg:grid-cols-4">
            <nav className="flex flex-col gap-4">
              <NavLink href="#pdp">PDP's</NavLink>
              <NavLink href="#video">Videos</NavLink>
            </nav>
            <nav className="flex flex-col gap-4">
              <NavLink href="#products">Products</NavLink>
              <NavLink href="#list">Our features</NavLink>
            </nav>
            <nav className="flex flex-col gap-2">
              <MetaLink href="#">Privacy Policy</MetaLink>
              <MetaLink href="#">Terms of Service</MetaLink>
              <MetaLink href="#">Cookie Policy</MetaLink>
            </nav>
            <nav className="flex flex-col gap-2">
              <MetaLink
                href="https://www.instagram.com/fourmula.ai"
                target="_blank"
                rel="noreferrer"
              >
                Instagram
              </MetaLink>
            </nav>
          </div>
        </div>

        {/* bottom */}
        <div className="mt-20 flex flex-col gap-1 text-xs text-black/35 sm:flex-row sm:justify-between">
          <span>© 2026, Fourmula ltd. UK, London. All rights reserved.</span>
          <span>Registered in England &amp; Wales No.: 13044361</span>
        </div>
      </div>

      {/* ── dot animation ── */}
      <DotGrid />
    </footer>
  )
}