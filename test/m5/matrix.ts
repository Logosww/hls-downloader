export const nativeTargets = [
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64-msvc',
  'win32-arm64-msvc',
];
export function validateMatrix(summaries: any[]) {
  if (
    summaries.length !== nativeTargets.length ||
    new Set(summaries.map((s) => s.commit)).size !== 1 ||
    !/^[a-f0-9]{40,64}$/.test(summaries[0]?.commit ?? '')
  )
    throw Error('Require six platform summaries from one immutable commit');
  for (const target of nativeTargets) {
    const matches = summaries.filter((s) => s.target === target);
    const s = matches[0];
    if (
      matches.length !== 1 ||
      s.gate !== 'platform' ||
      s.status !== 'passed' ||
      s.dirty !== false ||
      s.linkage?.static !== true ||
      s.qualification !== 'static platform package acceptance' ||
      !/^[a-f0-9]{64}$/.test(s.binary?.sha256 ?? '')
    )
      throw Error(`Missing or unqualified platform evidence: ${target}`);
    for (const name of [
      'linkage',
      'install-native',
      'native-runtime',
      'install-missing',
      'missing-contract',
      'consumer-types',
      'unsupported-target',
    ])
      if (
        !s.steps?.some(
          (step: any) => step.name === name && step.status === 'passed' && step.exitCode === 0,
        )
      )
        throw Error(`Missing check ${name} on ${target}`);
  }
}
