import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeEvent } from './transactionProtocol.js';

const FILE = 'RSReel_End_2100_33_38_20260813-151338_CP_000.zip';

test('edge phases correlate original and BPS-prefixed filenames', () => {
  assert.deepEqual(
    edgeEvent(`status=SUCCESS service=sftp operation=put arguments=/opt/Apps/BPSsftp/default/${FILE}`),
    { type: 'SFTP', corrId: FILE, ackCode: 'SUCCESS' },
  );
  assert.deepEqual(
    edgeEvent(`now | ${FILE} | D20260813T151053713.${FILE} | /tmp/D20260813T151053713.${FILE} | SUCCESS`),
    { type: 'BPS', corrId: FILE, ackCode: 'SUCCESS' },
  );
  assert.deepEqual(
    edgeEvent(`BPS-AUDIT-EVENT : ZIP_FILE_NM :D20260813T151053713.${FILE} XML_FILE_NM :Reject_Report_x.xml`),
    { type: 'CLOUDWATCH', corrId: FILE },
  );
});
