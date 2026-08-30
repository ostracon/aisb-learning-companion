const minimum = [22, 12, 0];
const current = process.versions.node.split(".").map(Number);

const supported = current.some((part, index) => {
  const priorPartsMatch = current
    .slice(0, index)
    .every((value, priorIndex) => value === minimum[priorIndex]);
  return priorPartsMatch && part > minimum[index];
}) || current.every((part, index) => part === minimum[index]);

if (!supported) {
  process.stderr.write(
    `AISB Learning Companion requires Node ${minimum.join(".")} or newer; this shell selected Node ${process.versions.node}.\n` +
      "Run `nvm use` in this repository (or select another supported Node runtime) and retry.\n",
  );
  process.exit(1);
}
