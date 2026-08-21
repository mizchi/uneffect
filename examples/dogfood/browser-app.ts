export function mount() {
  const target = document.getElementById("app");
  if (!target) return;
  target.textContent = String(performance.now());
  target.addEventListener("click", () => { target.textContent = "clicked"; });
}
