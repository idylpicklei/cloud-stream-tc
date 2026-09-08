export function HomePage() {
  return (
    <main className="page home-page">
      <section className="home-hero">
        <p className="eyebrow">Cloudflare Stream for classrooms</p>
        <h1>ClassStream</h1>
        <p className="lede">
          Go live from the browser with multiple microphones, then share one simple viewer link with
          your class.
        </p>
        <div className="cta-row">
          <a className="btn btn--primary btn--xl" href="/host">
            I am the teacher
          </a>
          <a className="btn btn--secondary btn--xl" href="/watch">
            I am watching
          </a>
        </div>
      </section>

      <section className="home-steps">
        <h2>How it works</h2>
        <ol>
          <li>Teacher opens the host studio and unlocks it with the shared password.</li>
          <li>Choose a camera, add mics (teacher, room, laptop), and check levels.</li>
          <li>Press Start Class. Share the viewer link. Press End Class when done.</li>
        </ol>
      </section>
    </main>
  );
}
