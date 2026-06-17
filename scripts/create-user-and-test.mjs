// scripts/create-user-and-test.mjs
//
// 1) Describe the deployed simple-bff-dev CloudFormation stack to get
//    UserPoolId, UserPoolClientId, and the HttpApi endpoint URL.
// 2) Create a Cognito user with AdminCreateUser (no email send).
// 3) Mark email_verified=true via AdminUpdateUserAttributes (no SES).
// 4) Set a permanent password via AdminSetUserPassword.
// 5) Sign in with USER_PASSWORD_AUTH flow to get id/access/refresh tokens.
// 6) Call the live API Gateway endpoint with the id_token and print
//    the response so we can see the authenticated JWT claims.

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  InitiateAuthCommand,
  DescribeUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const STACK = 'simple-bff-dev';
const ENDPOINT_PATH = '/hello';
const USERNAME = `tester+${Date.now()}@example.com`;
const PASSWORD = 'Test-Password-1234';

const cf = new CloudFormationClient({ region: REGION });
const cip = new CognitoIdentityProviderClient({ region: REGION });

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function main() {
  // 1) Read stack outputs
  const stack = await cf.send(new DescribeStacksCommand({ StackName: STACK }));
  const out = Object.fromEntries(
    (stack.Stacks?.[0]?.Outputs ?? []).map(o => [o.OutputKey, o.OutputValue])
  );
  log('Stack outputs (filtered)', Object.keys(out));
  if (!out.UserPoolId || !out.UserPoolClientId) {
    throw new Error('Stack outputs missing UserPoolId or UserPoolClientId');
  }
  const userPoolId = out.UserPoolId;
  const userPoolClientId = out.UserPoolClientId;
  // HttpApiUrl Output has the buggy Fn::Join+Fn::Sub from the framework.
  // Hardcode the real endpoint from the deploy output (8r8r6c1q51).
  const endpoint = `https://8r8r6c1q51.execute-api.${REGION}.amazonaws.com${ENDPOINT_PATH}`;
  log('Using endpoint', endpoint);
  log('Using UserPoolId', userPoolId);
  log('Using UserPoolClientId', userPoolClientId);
  log('Using username', USERNAME);

  // Confirm the user pool has email as a required+mutable attribute
  const pool = await cip.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
  log('User pool status', pool.UserPool?.Status);

  // 2) Create the user (SuppressMessage so Cognito does not try to send
  // a welcome email — we have no SES configured).
  try {
    const created = await cip.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: USERNAME,
      UserAttributes: [
        { Name: 'email', Value: USERNAME },
        { Name: 'email_verified', Value: 'true' },
      ],
      MessageAction: 'SUPPRESS',
    }));
    log('User created', created.User?.Username);
  } catch (e) {
    if (e.name === 'UsernameExistsException') {
      log('User already exists, continuing', USERNAME);
    } else {
      throw e;
    }
  }

  // 3) Set a permanent password (auto-confirms the user).
  await cip.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: USERNAME,
    Password: PASSWORD,
    Permanent: true,
  }));
  log('Password set', 'OK (permanent)');

  // 4) Sign in with USER_PASSWORD_AUTH (we set Permanent:true, which
  // enables the admin-auth flow alongside USER_SRP_AUTH).
  const auth = await cip.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: userPoolClientId,
    AuthParameters: {
      USERNAME: USERNAME,
      PASSWORD: PASSWORD,
    },
  }));
  log('Auth result', {
    access_token: auth.AuthenticationResult?.AccessToken?.slice(0, 20) + '...',
    id_token: auth.AuthenticationResult?.IdToken?.slice(0, 20) + '...',
    refresh_token: auth.AuthenticationResult?.RefreshToken?.slice(0, 20) + '...',
    expires_in: auth.AuthenticationResult?.ExpiresIn,
    token_type: auth.AuthenticationResult?.TokenType,
  });

  const idToken = auth.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error('No id_token returned');

  // 5) Call the live endpoint
  const resp = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const body = await resp.text();
  log(`HTTP ${resp.status} from ${endpoint}`, body);
}

main().catch(err => {
  console.error('FAILED:', err.name || '', err.message);
  if (err.$metadata) console.error('  statusCode:', err.$metadata.httpStatusCode);
  process.exit(1);
});
