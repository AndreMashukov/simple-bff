import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const USER_POOL_ID = process.env.USER_POOL_ID;
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
if (!USER_POOL_ID || !CLIENT_ID) {
  throw new Error('Set USER_POOL_ID and USER_POOL_CLIENT_ID before running.');
}

const c = new CognitoIdentityProviderClient({ region: REGION });

// Read current settings first so the UpdateUserPoolClient call does not
// clobber CallbackURLs / AllowedOAuthFlows / etc. with their defaults.
const cur = await c.send(new DescribeUserPoolClientCommand({
  UserPoolId: USER_POOL_ID,
  ClientId: CLIENT_ID,
}));
const existing = cur.UserPoolClient ?? {};

const r = await c.send(new UpdateUserPoolClientCommand({
  UserPoolId: USER_POOL_ID,
  ClientId: CLIENT_ID,
  ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'],
  CallbackURLs: existing.CallbackURLs,
  LogoutURLs: existing.LogoutURLs,
  AllowedOAuthFlows: existing.AllowedOAuthFlows,
  AllowedOAuthScopes: existing.AllowedOAuthScopes,
  AllowedOAuthFlowsUserPoolClient: existing.AllowedOAuthFlowsUserPoolClient,
  SupportedIdentityProviders: existing.SupportedIdentityProviders,
  PreventUserExistenceErrors: existing.PreventUserExistenceErrors,
}));
console.log('updated, flows:', r.UserPoolClient?.ExplicitAuthFlows);
