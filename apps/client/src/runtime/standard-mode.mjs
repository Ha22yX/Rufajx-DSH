// Route fresh and resumed sessions through the native Standard composition.
// Historical session events remain intact even if they recorded an older preset.
export function installStandardMode(registry) {
  const originalDefault = Object.getOwnPropertyDescriptor(registry, 'defaultId');
  Object.defineProperty(registry, 'defaultId', { configurable: true, get: () => 'standard' });
  const originals = new Map();
  function wrap(key, factory) {
    const previous = registry[key], replacement = factory(previous);
    originals.set(key, { previous, replacement }); registry[key] = replacement;
  }
  wrap('list', previous => async function(...args) { return (await previous.apply(this, args)).filter(row => row.id === 'standard'); });
  for (const key of ['resolve', 'acquireScope']) wrap(key, previous => function() { return previous.call(this, 'standard'); });
  for (const key of ['mount', 'select']) wrap(key, previous => function(target) { return previous.call(this, target, 'standard'); });
  return () => {
    for (const [key, { previous, replacement }] of originals) if (registry[key] === replacement) registry[key] = previous;
    if (originalDefault) Object.defineProperty(registry, 'defaultId', originalDefault);
    else delete registry.defaultId;
  };
}
