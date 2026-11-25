// The shared formatter splits decimal strings at a literal dot, without a limit.
// Even an empty string gives one field here. TypeScript's general split signature loses that fact.
interface String {
  split(separator: '.'): [string, ...string[]]
}
