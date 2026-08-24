// Writing through a binding that outlives the call is a Mutate effect over that region.
const state = { calls: 0 };

export function record() {
  state.calls = state.calls + 1;
}
