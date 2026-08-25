export function buildCaptureReport({
  appName,
  packageName,
  startedAt,
  stoppedAt,
  rawPcap,
  mappingFile,
  extractedDir,
  marks = [],
}) {
  const lines = [
    '# Capture Report',
    '',
    `- App: ${appName || ''}`,
    `- Package: ${packageName || ''}`,
    `- Started At: ${startedAt || ''}`,
    `- Stopped At: ${stoppedAt || ''}`,
    `- Raw PCAP: ${rawPcap || ''}`,
    `- Port Mapping: ${mappingFile || ''}`,
    `- Extracted Output: ${extractedDir || ''}`,
    '',
    '## Marks',
    '',
  ];

  if (marks.length === 0) {
    lines.push('- None');
  } else {
    for (const mark of marks) {
      lines.push(`- ${mark.label || 'mark'}: ${mark.at}`);
    }
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Capture should be filtered by package-derived port mapping and time window.');
  lines.push('- High-risk actions such as payment, ticket grabbing, order submission, likes, follows, comments, and rewards are not automated.');

  return lines.join('\n');
}
