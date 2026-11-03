// Contract fixtures: two household users with private conversations, plus
// single-use enrollment material for tests and DevicePanel development.
// All secrets are synthetic (`fixture-...`) and safe to keep in the repo;
// they only work against FakeHomeServer, never a real home.

export interface FixtureUser {
  userId: string;
  displayName: string;
  conversationId: string;
}

export interface FixtureInvitation {
  invitationId: string;
  pairingSecret: string;
  /** Checked against the server's enrollment reply; never sent as identity. */
  expectedUserId: string;
}

export interface TwoUserFixture {
  installationId: string;
  homeBaseUrl: string;
  userA: FixtureUser;
  userB: FixtureUser;
  invitationA: FixtureInvitation;
  invitationB: FixtureInvitation;
  /** Same invitation issued twice to prove single-use/race behavior. */
  racedInvitation: FixtureInvitation;
}

export function buildTwoUserFixture(): TwoUserFixture {
  return {
    installationId: 'install_fixture_1',
    homeBaseUrl: 'https://home.invalid',
    userA: {
      userId: 'user_fixture_anna',
      displayName: 'Anna',
      conversationId: 'conv_fixture_anna_1',
    },
    userB: {
      userId: 'user_fixture_ben',
      displayName: 'Ben',
      conversationId: 'conv_fixture_ben_1',
    },
    invitationA: {
      invitationId: 'invite_fixture_anna_1',
      pairingSecret: 'fixture-secret-anna-0001',
      expectedUserId: 'user_fixture_anna',
    },
    invitationB: {
      invitationId: 'invite_fixture_ben_1',
      pairingSecret: 'fixture-secret-ben-0001',
      expectedUserId: 'user_fixture_ben',
    },
    racedInvitation: {
      invitationId: 'invite_fixture_race_1',
      pairingSecret: 'fixture-secret-race-0001',
      expectedUserId: 'user_fixture_anna',
    },
  };
}

export function fixtureDeviceLabel(deviceName: string) {
  return `${deviceName} (fixture phone)`;
}
