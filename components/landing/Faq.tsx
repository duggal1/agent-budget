"use client";
import { useState } from "react";

interface FAQItem { q: string; a: string }

const faqs: FAQItem[] = [
  {
    q: "Does this work with my existing provider?",
    a: "Yes. Bring your own executor — OpenAI, Together AI, Fireworks, Ollama, or raw fetch to any OpenAI-compatible endpoint. No provider is bundled.",
  },
  {
    q: "What happens when a limit is exceeded?",
    a: "The step is rolled back from the tracker and a BudgetError is thrown. Actual spend stays accurate for retry. Pass onExceeded as a callback if you want to handle it without throwing.",
  },
  {
    q: "How accurate is the pre-flight estimate?",
    a: "Defaults to 512 output tokens. Tune preflightOutputTokenEstimate per call, or disable pre-flight entirely and rely on post-step enforcement.",
  },
  {
    q: "Can I resume after a crash?",
    a: "Yes. Checkpoints persist state between restarts. Use AgentBudget.resume() to reload a prior run without replaying already-billed calls.",
  },
  {
    q: "Does it support streaming?",
    a: "Yes. Pass stream: true and listen for step:token events. Cost and token tracking work identically in streaming and non-streaming modes.",
  },
];

export default function FAQ() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section id="faq" className="py-24 px-6 border-t border-neutral-100">
      <div className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-12 gap-8">
        <div className="md:col-span-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-neutral-400">FAQ</p>
        </div>
        <div className="md:col-span-7 md:col-start-3">
          <h2 className="text-[28px] font-normal tracking-[-0.02em] text-[#111111] mb-10">
            Have questions?{" "}
            <span className="text-neutral-400">Find answers.</span>
          </h2>

          <div className="flex flex-col">
            {faqs.map((faq, i) => (
              <div key={i} className="border-b border-neutral-100">
                <button
                  onClick={() => setOpen(open === i ? null : i)}
                  className="flex w-full items-center justify-between py-4 text-left text-[15px] text-[#111111] hover:text-neutral-500 transition-colors"
                >
                  <span>{faq.q}</span>
                  <svg
                    width="16" height="16" viewBox="0 0 16 16" fill="none"
                    className={`shrink-0 ml-4 text-neutral-400 transition-transform duration-200 ${open === i ? "rotate-180" : ""}`}
                  >
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className={`overflow-hidden transition-all duration-200 ease-in-out ${open === i ? "max-h-40 pb-4" : "max-h-0"}`}>
                  <p className="text-[13px] text-neutral-500 leading-relaxed">{faq.a}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-8 text-[13px] text-neutral-400">
            Still have questions?{" "}
            <a href="mailto:hi@painitehq.com" className="text-[#111111] underline decoration-dotted underline-offset-2">
              Contact us
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}