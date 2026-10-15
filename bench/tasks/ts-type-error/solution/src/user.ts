export interface User {
  id: number;
  name: string;
  email?: string;
}

export function displayName(user: User): string {
  return user.email ? `${user.email.split('@')[0]} (${user.name})` : user.name;
}

export function findUser(users: User[], id: number): User | undefined {
  return users.find((u) => u.id === id);
}
