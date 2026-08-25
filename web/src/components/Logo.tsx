/**
 * The Antla mark. The 128px file is for the rail and login; the tab uses
 * `web/public/favicon.png` at 32px, which is a separate draw.
 */
export function Logo() {
  return (
    <img
      className="brand-mark"
      src="/logo.png"
      width={128}
      height={128}
      alt=""
      aria-hidden="true"
    />
  );
}
