const links = ["How it works", "Features", "FAQ"];

export default function Nav() {
  return (
    <header className="fixed top-0 inset-x-0 z-50 border-b border-neutral-100 bg-white/80 backdrop-blur-md">
      <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between">
        <img src="/logo.svg" alt="logo" className="h-7 w-auto" />

        <nav className="hidden md:flex items-center gap-7">
          {links.map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase().replace(" ", "-")}`}
              className="text-[13px] text-neutral-500 hover:text-[#111111] transition-colors"
            >
              {item}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href="#"
            className="px-3 py-1.5 text-[13px] text-neutral-500 hover:text-[#111111] transition-colors"
          >
            Login
          </a>

          <a
            href="#"
            className="rounded-[10px] bg-neutral-800 hover:bg-neutral-900 transition-colors px-4 py-1.5 text-[13px] font-medium text-white"
          >
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}