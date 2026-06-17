import { CognitoIdentityProviderClient, UpdateUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
const c = new CognitoIdentityProviderClient({ region: 'ap-southeast-1' });
const r = await c.send(new UpdateUserPoolClientCommand({
  UserPoolId: 'ap-southeast-1_zc18WFqD2',
  ClientId: 'nfk8eg7ofa677tvkg5qok4e73',
  ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'],
}));
console.log('updated, flows:', r.UserPoolClient?.ExplicitAuthFlows);
