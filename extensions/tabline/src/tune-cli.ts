/** Optional terminal entry for the same /tune implementation (Node 22.19+). */
import { parseArgs, scan } from './tune-scan.ts';
import { formatReport } from './tune.ts';
try {
 const args = process.argv.slice(2), asJson = args.includes('--json');
 const report = await scan(parseArgs(args.filter(a => a !== '--json').join(' ')));
 console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
} catch (error) {
 console.error(error instanceof Error ? error.message : 'Tuning scan failed.');
 process.exitCode = 1;
}
