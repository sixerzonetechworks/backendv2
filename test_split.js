const requiredHours = [6, 7, 8, 9, 10, 11];
const matrix = {
  G1: { 6: false, 7: false, 8: true, 9: false, 10: true, 11: true },
  G2: { 6: true, 7: true, 8: false, 9: true, 10: false, 11: true }
};
const splitGrounds = ['G1', 'G2'];
const splitPaths = [];

function findSplitPaths(slotIndex, currentPath, switchCount) {
  if (slotIndex === requiredHours.length) {
    if (switchCount > 0) {
      splitPaths.push({
        path: [...currentPath],
        switches: switchCount
      });
    }
    return;
  }

  const hour = requiredHours[slotIndex];

  for (const groundName of splitGrounds) {
    if (!matrix[groundName] || !matrix[groundName][hour]) continue;

    const lastGround = currentPath.length > 0
      ? currentPath[currentPath.length - 1].groundName
      : null;

    let newSwitchCount = switchCount;
    if (lastGround && lastGround !== groundName) {
      newSwitchCount++;
    }

    currentPath.push({ hour, groundName, price: 100 });
    findSplitPaths(slotIndex + 1, currentPath, newSwitchCount);
    currentPath.pop();
  }
}

findSplitPaths(0, [], 0);

console.log("Found splitPaths:", splitPaths.length);

const seenSequences = new Set();
const splitOptionsCandidate = [];

for (const { path, switches } of splitPaths) {
  const sequence = path.map(s => s.groundName).join(',');
  if (seenSequences.has(sequence)) continue;
  seenSequences.add(sequence);

  const segments = [];
  let currentSegment = { groundName: path[0].groundName, hours: [path[0].hour] };
  for (let i = 1; i < path.length; i++) {
    if (path[i].groundName === currentSegment.groundName) {
      currentSegment.hours.push(path[i].hour);
    } else {
      segments.push(currentSegment);
      currentSegment = { groundName: path[i].groundName, hours: [path[i].hour] };
    }
  }
  segments.push(currentSegment);

  splitOptionsCandidate.push({ switches, segments });
}

console.log("Candidate options:", splitOptionsCandidate.length);

if (splitOptionsCandidate.length > 0) {
  const minSwitches = Math.min(...splitOptionsCandidate.map(o => o.switches));
  const bestOptions = splitOptionsCandidate.filter(o => o.switches === minSwitches);
  console.log("Best option switches:", bestOptions[0].switches);
  console.log("Segments array length:", bestOptions[0].segments.length);
} else {
  console.log("No valid split options found.");
}
