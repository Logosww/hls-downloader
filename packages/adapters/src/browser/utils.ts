import pLimit from 'p-limit';

export const promiseWithLimit = async <T>(
  promises: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> => {
  if (promises.length === 0) {
    return [];
  }

  const limitPromise = pLimit(limit);

  const results = await Promise.all(
    promises.map((promise) =>
      limitPromise(typeof promise === 'function' ? promise : () => promise),
    ),
  );

  return results;
};

