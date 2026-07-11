export function rightToLeftPageOrder(first, second) {
  return [second, first];
}

export function bridgeChapterPages(
  previousPage,
  nextPage
) {
  if (
    !previousPage ||
    !nextPage ||
    !previousPage.isVertical ||
    !nextPage.isVertical
  ) {
    return null;
  }

  return {
    type: "pair",
    first: previousPage,
    second: nextPage,
    pages: rightToLeftPageOrder(
      previousPage,
      nextPage
    )
  };
}

export function splitOperationsBySize(
  operations,
  maxSize
) {
  const groups = [];
  let current = [];
  let currentSize = 0;

  for (const operation of operations) {
    const size = Number(operation.size || 0);
    const wouldExceed =
      current.length > 0 &&
      currentSize + size > maxSize;

    if (wouldExceed) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(operation);
    currentSize += size;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}
