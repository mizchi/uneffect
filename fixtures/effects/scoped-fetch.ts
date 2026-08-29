// A scoped effect is an authority, not a name: the in-scope call verifies, the out-of-scope one does not.
/* uneffect:capability effect Fetch<GET, "https://api.example.com/**"> | Net<"api.example.com:443"> */
export function loadUsers() {
  return fetch("https://api.example.com/users");
}

/* uneffect:capability effect Fetch<GET, "https://api.example.com/**"> | Net<"api.example.com:443"> */
export function loadReport() {
  return fetch("https://reports.example.com/latest");
}
