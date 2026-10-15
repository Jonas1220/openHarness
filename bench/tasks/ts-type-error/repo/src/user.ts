export interface User {
  id: number;
  name: string;
  email?: string;
}

export function displayName(user: User): string {
  return user.email.split('@')[0] + ' (' + user.name + ')';
}

export function findUser(users: User[], id: string): User | undefined {
  return users.find((u) => u.id === id);
}
