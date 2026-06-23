'use client'

import { useCallback, useEffect, useRef } from 'react'
import gsap from 'gsap'

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
const ANIM_DUR     = 1
const HOLD_DUR     = 1
const N_GROUPS     = 20
const CHAOS        = 0.35
const DIM          = 0.15

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
    const size = m === 'mobile' ? '5px' : '10px'
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

  const showCloud = useCallback(() => {
    const cols = COLS[modeRef.current ?? 'desktop']
    const cx   = Math.floor(cols / 2)
    const cy   = Math.floor(ROWS / 2)
    stagger(dotsRef.current, d => {
      const dist = Math.hypot(+d.dataset.c! - cx, +d.dataset.r! - cy)
      const core = Math.max(0, 1 - dist / CLOUD_RADIUS)
      return Math.min(1, Math.max(DIM, DIM + core * 0.7 + (Math.random() - 0.5) * CHAOS))
    })
  }, [])

  const showPattern = useCallback((idx: number) => {
    const cols = COLS[modeRef.current ?? 'desktop']
    const cx   = Math.floor(cols / 2)
    const cy   = Math.floor(ROWS / 2)
    const lit  = new Set<string>()
    PATTERNS[idx].forEach((row, r) =>
      [...row].forEach((ch, c) => { if (ch === '1') lit.add(`${cx - 9 + c},${cy - 9 + r}`) }),
    )
    stagger(dotsRef.current, d => (lit.has(`${d.dataset.c},${d.dataset.r}`) ? 1 : DIM))
  }, [])

  const cycle = useCallback(() => {
    showPattern(patternIdx.current)
    later(() => {
      patternIdx.current = (patternIdx.current + 1) % PATTERNS.length
      showCloud()
      later(cycle, ANIM_DUR * 1000)
    }, (ANIM_DUR + HOLD_DUR) * 1000)
  }, [showPattern, showCloud])

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
  }, [build, showCloud, cycle])

  return (
    <div className="absolute inset-0 flex justify-center">
      <div
        ref={wrapRef}
        style={{ display: 'grid', pointerEvents: 'none' }}
      />
    </div>
  )
}

export default function Footer() {
  return (
    <footer className="relative overflow-hidden bg-white text-black h-48">
      <DotGrid />
    </footer>
  )
}
