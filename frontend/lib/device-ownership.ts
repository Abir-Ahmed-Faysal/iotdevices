export function ownedDeviceFilter(userId: string) {
  return { home: { members: { some: { userId } } } };
}
