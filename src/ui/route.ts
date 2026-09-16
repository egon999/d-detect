/**
 * Values arriving from the URL.
 *
 * The counterpart to `readable.ts`. That file narrows a value on its way *out* to the
 * screen; this one narrows a value on its way *in* from the router, which is the other
 * place a screen holds something it did not write and cannot narrow to a type.
 *
 * `useLocalSearchParams` is generic, and every screen in this app took the invitation to
 * declare its parameter as `string`. That is not what the hook returns. Its real type is
 * `string | string[] | undefined`: a segment can repeat, a screen can render for a frame
 * while the route is still resolving, and on the web the address bar is a text field that
 * anyone can edit — `/case//upload` is a URL a person can type and a link can carry.
 *
 * Declaring `string` there does not make any of that go away; it only stops the compiler
 * from mentioning it, and hands `undefined` to everything downstream under a type that
 * says it cannot be. The stores are honest about this already — `useWorkspace` and
 * `useCaseRecord` both take `string | null` and return an empty result for `null` — so a
 * screen that narrows here lands on the not-found state it already renders, rather than
 * carrying an `undefined` into a mutation as if it were an id.
 *
 * An array takes its first entry rather than being rejected: a repeated segment is a
 * malformed link, not a different case, and the first value is the one the route matched.
 * Everything else — absent, empty, whitespace — is `null`, one shape for one meaning.
 */
export function routeParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof first === 'string' ? first.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}
