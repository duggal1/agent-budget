interface Feature {
  label: string;
  body: string;
  tag: string;
  tagColor: string;
}

const features: Feature[] = [
  {
    label: "Catch overruns before they happen",
    body: "Pre-flight checks estimate output cost before the API call fires. Already over budget — the call never lands.",
    tag: "Pre-flight",
    tagColor: "bg-violet-100 text-violet-700",
  },
  {
    label: "Hard limits. Not suggestions.",
    body: "Ceilings on cost, input tokens, output tokens, steps, wall time. Any one exceeded — agent stops, step rolled back, no partial charges.",
    tag: "Enforcement",
    tagColor: "bg-rose-100 text-rose-700",
  },
  {
    label: "Downgrade as budget depletes",
    body: "Define a fallback chain. As spend crosses thresholds the router moves to a cheaper model — no code changes, no manual intervention.",
    tag: "Adaptive routing",
    tagColor: "bg-amber-100 text-amber-700",
  },
  {
    label: "Loops detected and killed",
    body: "The circuit breaker watches for repetition and stagnation across steps. If the agent is spinning, it stops before the spin costs you.",
    tag: "Circuit breaker",
    tagColor: "bg-sky-100 text-sky-700",
  },
  {
    label: "Works with any provider",
    body: "OpenRouter, OpenAI, Together AI, Fireworks, Ollama, raw fetch. Bring your own executor. No provider bundled, no model defaulted.",
    tag: "Provider-agnostic",
    tagColor: "bg-emerald-100 text-emerald-700",
  },
  {
    label: "Survive restarts",
    body: "Checkpoints persist agent state. Resume mid-run after a crash or deploy without replaying calls already billed.",
    tag: "Checkpoints",
    tagColor: "bg-neutral-100 text-neutral-600",
  },
];

export default function Features() {
  return (
    <section id="features" className="py-24 px-6 border-t border-neutral-100">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-xl mb-16">
          <p className="mb-3 text-[11px] uppercase tracking-[0.08em] text-neutral-400">Features</p>
          <h2 className="text-[32px] font-normal tracking-[-0.02em] text-[#111111] leading-snug">
            Most agent frameworks let loops run.{" "}
            <span className="text-neutral-400">PainiteHQ does not.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {features.map((f) => (
            <div
              key={f.label}
              className="rounded-xl bg-neutral-50 border border-neutral-100 px-5 py-5 space-y-3 hover:border-neutral-200 transition-colors"
            >
              <span className={`inline-block rounded-[5px] px-2 py-0.75 text-[11px] ${f.tagColor}`}>
                {f.tag}
              </span>
              <h3 className="text-[15px] font-medium tracking-[-0.01em] text-[#111111] leading-snug">
                {f.label}
              </h3>
              <p className="text-[13px] text-neutral-500 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-20 max-w-2xl">
          <p className="text-[22px] font-normal leading-relaxed tracking-[-0.01em] text-[#111111]">
            Most agent frameworks treat every loop the same — a step to execute, a token to spend, a call to log. They are built to run agents, not to stop them.
          </p>
          <p className="mt-6 text-[22px] font-normal leading-relaxed tracking-[-0.01em] text-neutral-400">
          Budget-agent by PainiteHQ is different. Budget enforcement runs across every step — checking limits before the call fires and after it lands, rolling back overages, routing to cheaper models as spend climbs.
          </p>
        </div>
      </div>
    </section>
  );
}