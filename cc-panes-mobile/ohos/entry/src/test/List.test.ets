import localUnitTest from './LocalUnit.test';
import layoutSnapshotTest from './LayoutSnapshot.test';

export default function testsuite() {
  localUnitTest();
  layoutSnapshotTest();
}
