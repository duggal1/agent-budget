import FAQ from "@/components/landing/Faq";
import Features from "@/components/landing/feature";
import Footer from "@/components/landing/footer";
import Hero from "@/components/landing/hero";
import Nav from "@/components/landing/nav";



export default function Home() {
  return (
    <main className="min-h-screen bg-white font-sans antialiased overflow-x-hidden">
      <Nav />
      <Hero />
      <Features />
      <FAQ />
      <Footer/>
    </main>
  );
}