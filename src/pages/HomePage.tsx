import { BrandMark } from "../components/BrandMark";

export function HomePage() {
  return (
    <main className="page home-page">
      <section className="home-hero" aria-label="Training Center">
        <div className="home-hero__copy">
          <BrandMark size="hero" as="h1" />
          <p className="home-hero__headline">Teach live. Students join one link.</p>
          <p className="lede">
            Open the studio, mix camera and microphones in the browser, then share the watch link with
            your class.
          </p>
          <div className="cta-row">
            <a className="btn btn--primary btn--xl" href="/host">
              Open studio
            </a>
            <a className="btn btn--secondary btn--xl" href="/watch">
              Watch
            </a>
          </div>
        </div>
      </section>

      <section className="home-steps">
        <h2>How it works</h2>
        <ol>
          <li>Instructors open the studio and unlock it with the shared password.</li>
          <li>Choose a camera, add optional PiP (slides / 2nd camera / screen), and check mic levels.</li>
          <li>Press Start class. Share the viewer link. Press End class when done.</li>
        </ol>
      </section>
    </main>
  );
}
