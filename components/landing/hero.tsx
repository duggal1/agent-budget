'use client'

import { useState, useEffect, useRef } from 'react'
import { Copy01Icon as CopyIcon, CheckmarkCircle01Icon as CheckIcon } from 'hugeicons-react'

interface Token { t: string; c: string }
interface CodeLine { tokens: Token[] }

const lines: CodeLine[] = [
  { tokens: [{ t: "import", c: "text-violet-600" }, { t: " { AgentBudget } ", c: "text-neutral-800" }, { t: "from", c: "text-violet-600" }, { t: " 'budget-agent'", c: "text-emerald-600" }] },
  { tokens: [] },
  { tokens: [{ t: "const ", c: "text-violet-600" }, { t: "agent ", c: "text-neutral-800" }, { t: "= ", c: "text-neutral-400" }, { t: "new ", c: "text-violet-600" }, { t: "AgentBudget", c: "text-blue-600" }, { t: "({", c: "text-neutral-400" }] },
  { tokens: [{ t: "  apiKey", c: "text-sky-600" }, { t: ": ", c: "text-neutral-400" }, { t: "process.env", c: "text-emerald-600" }, { t: ".OPENROUTER_API_KEY,", c: "text-neutral-700" }] },
  { tokens: [{ t: "  limits", c: "text-sky-600" }, { t: ": {", c: "text-neutral-400" }] },
  { tokens: [{ t: "    maxCostUSD", c: "text-sky-600" }, { t: ":  ", c: "text-neutral-400" }, { t: "0.05", c: "text-amber-600" }, { t: ",", c: "text-neutral-400" }] },
  { tokens: [{ t: "    maxSteps", c: "text-sky-600" }, { t: ":     ", c: "text-neutral-400" }, { t: "10", c: "text-amber-600" }, { t: ",", c: "text-neutral-400" }] },
  { tokens: [{ t: "    maxWallTimeMs", c: "text-sky-600" }, { t: ": ", c: "text-neutral-400" }, { t: "60_000", c: "text-amber-600" }] },
  { tokens: [{ t: "  },", c: "text-neutral-400" }] },
  { tokens: [{ t: "});", c: "text-neutral-400" }] },
  { tokens: [] },
  { tokens: [{ t: "const ", c: "text-violet-600" }, { t: "response ", c: "text-neutral-800" }, { t: "= ", c: "text-neutral-400" }, { t: "await ", c: "text-violet-600" }, { t: "agent", c: "text-blue-600" }, { t: ".step({", c: "text-neutral-400" }] },
  { tokens: [{ t: "  model", c: "text-sky-600" }, { t: ": ", c: "text-neutral-400" }, { t: "'anthropic/claude-opus-4.8-fast'", c: "text-emerald-600" }, { t: ",", c: "text-neutral-400" }] },
  { tokens: [{ t: "  messages", c: "text-sky-600" }, { t: ": messages", c: "text-neutral-800" }] },
  { tokens: [{ t: "});", c: "text-neutral-400" }] },
  { tokens: [] },
  { tokens: [{ t: "console", c: "text-blue-600" }, { t: ".log(", c: "text-neutral-400" }, { t: "agent", c: "text-blue-600" }, { t: ".getUsage())", c: "text-neutral-400" }] },
  { tokens: [{ t: "// ", c: "text-neutral-400" }, { t: "{ steps: 1, totalCostUSD: 0.000015, totalInputTokens: 12 }", c: "text-neutral-400" }] },
]

const codeString = lines.map(l => l.tokens.map(t => t.t).join('')).join('\n')

function extractDomain(url: string): string {
  let domain = url.trim()
  domain = domain.replace(/^https?:\/\//, '')
  domain = domain.split(/[/?#]/)[0]
  return domain.toLowerCase()
}

function getFaviconUrl(domain: string): string {
  const clean = extractDomain(domain)
  if (!clean) return ''
  return `https://www.google.com/s2/favicons?domain=${clean}&sz=64`
}

const installers = [
  { label: 'npm', cmd: 'npm install budget-agent', domain: 'npmjs.com' },
  { label: 'bun', cmd: 'bun add budget-agent', domain: 'bun.sh' },
  { label: 'pnpm', cmd: 'pnpm add budget-agent', domain: 'pnpm.io' },
]

function InstallButton() {
  const [idx, setIdx] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const cycle = () => {
    setPhase('out')
    setTimeout(() => {
      setIdx(i => (i + 1) % installers.length)
      setPhase('in')
    }, 300)
    setTimeout(() => setPhase('idle'), 600)
  }

  const start = () => {
    intervalRef.current = setInterval(cycle, 3500)
  }

  const stop = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  useEffect(() => {
    start()
    return stop
  }, [])

  const current = installers[idx]

  return (
    <button
      onClick={() => navigator.clipboard.writeText(current.cmd)}
      onMouseEnter={stop}
      onMouseLeave={start}
      className="rounded-[10px] bg-neutral-800 hover:bg-neutral-900 transition-colors px-5 py-2 text-[13px] font-medium text-white flex items-center gap-2 cursor-pointer active:scale-[0.97]"
    >
      <span
        className="flex items-center gap-2"
        style={{
          filter: phase === 'out' ? 'blur(4px)' : phase === 'in' ? 'blur(4px)' : 'blur(0)',
          opacity: phase === 'out' ? 0 : phase === 'in' ? 0 : 1,
          transition: 'filter 0.25s ease, opacity 0.25s ease',
        }}
      >
        <img src={getFaviconUrl(current.domain)} alt={current.label} className="w-3.5 h-3.5 shrink-0 rounded-[2px]" />
        Install with {current.label}
      </span>
    </button>
  )
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={copy}
      className="ml-auto flex items-center gap-1.5 rounded-lg border border-neutral-100 bg-white  hover:border-neutral-200 cursor-pointer py-1 px-3 text-[11px] text-neutral-500 font-sans hover:bg-neutral-50 active:scale-95 transition-all"
    >
      <span className={`flex items-center gap-1 transition-opacity duration-200 ${copied ? 'opacity-0 absolute' : 'opacity-100'}`}>
        <CopyIcon size={16} />
        Copy
      </span>
      <span className={`flex items-center gap-1 text-neutral-500 transition-opacity duration-200 ${copied ? 'opacity-100' : 'opacity-0 absolute'}`}>
        <CheckIcon size={16} />
        Copied!
      </span>
    </button>
  )
}

export default function Hero() {
  return (
    <section className="relative pt-32 pb-24 px-6 overflow-hidden">

      {/* background: plain div, no next/image nonsense */}
      <div className="absolute inset-0 -z-10 bg-[url('/bg-cloud.jpg')] bg-cover bg-position-[center_top]" />
      <div className="absolute inset-0 -z-10 bg-linear-to-b from-transparent via-white/20 to-white" />

      <div className="mx-auto max-w-6xl">
        <h1 className="text-center text-[44px] md:text-[60px] font-normal leading-[1.08] tracking-tight text-[#111111] max-w-3xl mx-auto mb-5">
          Stop runaway agents before they drain your budget
        </h1>

        <p className="text-center text-[15px] text-neutral-500 max-w-lg mx-auto mb-10 leading-relaxed">
          budget-agent sits between your agent and the LLM. Hard limits on cost, tokens, and steps — enforced pre-flight and post-step.
        </p>

       <div className="flex items-center justify-center gap-3 mb-16">
  <InstallButton />

  <a
    href="#features"
    className="rounded-[10px] border border-neutral-200 bg-white hover:bg-neutral-50 transition-colors px-5 py-2 text-[13px] text-neutral-600"
  >
    View Documentation
  </a>
</div>

        {/* SDK window */}
        <div className="relative mx-auto max-w-5xl">
          <div className="absolute -inset-6 rounded-xl bg-white/40 backdrop-blur-2xl" />

          <div className="relative rounded-xl overflow-hidden border border-neutral-100 bg-neutral-50">
            {/* title bar */}
            <div className="flex items-center gap-1.5 px-4 py-3 bg-neutral-100 border-b border-neutral-200">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-[11px] text-neutral-400 font-mono">agent.ts</span>
              <CopyButton code={codeString} />
            </div>

            {/* code */}
            <div className="px-5 py-5 font-mono text-[12.5px] leading-[1.8]">
              {lines.map((line, i) => (
                <div key={i} className="flex">
                  <span className="w-7 shrink-0 text-right mr-5 text-neutral-300 select-none text-[11px] leading-[1.8]">
                    {i + 1}
                  </span>
                  <span>
                    {line.tokens.length === 0
                      ? <span>&nbsp;</span>
                      : line.tokens.map((tok, j) => (
                          <span key={j} className={tok.c}>{tok.t}</span>
                        ))
                    }
                  </span>
                </div>
              ))}
            </div>

            {/* status bar */}
            <div className="px-5 py-2.5 border-t border-neutral-200 bg-neutral-100 flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                budget guard active
              </span>
              <span className="text-[11px] text-neutral-400 font-mono">
                $0.00 / $0.05 · 0 / 10 steps · 0ms
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}