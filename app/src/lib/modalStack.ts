// Tracks application-owned modal lifecycles so global shortcuts stay isolated
// from content behind the topmost dialog without querying presentation markup.
let openModalCount = 0;

export function registerOpenModal(): () => void {
  openModalCount += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    openModalCount = Math.max(0, openModalCount - 1);
  };
}

export function hasOpenModal(): boolean {
  return openModalCount > 0;
}
