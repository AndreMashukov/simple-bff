Simple BFF — Serverless Framework v4 with API Gateway HTTP API plus Cognito
====================================================================

This is a minimal Serverless Framework v4 service that deploys a single
AWS Lambda behind an API Gateway HTTP API (v2), protected by a Cognito
User Pool JWT authorizer. A Cognito Hosted UI domain is created so you
can log in via a browser and grab a real JWT to test the endpoint with.

What gets created when you run sls deploy
-----------------------------------------

  - 3 AWS Lambda functions
      - hello         (HTTP API handler, GET /hello, /events)
      - listener      (SQS consumer; materialises upstream events)
      - trigger       (DynamoDB stream CDC; re-publishes entity changes)
  - 1 API Gateway HTTP API  (HttpApi)
  - 1 EventBridge bus        (default, shared with the local stack)
  - 1 EventBridge rule       (ListenerRule, source-anything-but-self)
  - 1 SQS queue              (ListenerQueue, with DLQ)
  - 1 DynamoDB table         (EntitiesTable, on-demand, streams ON)
  - 1 Cognito User Pool     (UserPool)
  - 1 Cognito User Pool App Client (UserPoolClient, public, PKCE-ready)
  - 1 Cognito User Pool Domain     (UserPoolDomain, the Hosted UI)
  - 1 API Gateway JWT Authorizer   (CognitoHttpApiAuthorizer)
  - IAM roles per function
  - CloudWatch log groups per function

Deploy
------

1. Register at https://app.serverless.com (free for organisations under
   2M USD annual revenue). Create an access key.
2. Export it in your shell:

       export SERVERLESS_ACCESS_KEY=<your-key>

3. From this directory, deploy:

       npm install
       npm run deploy:dev

4. The deploy prints the stack outputs. You will see:

       HttpApiUrl                https://<id>.execute-api.ap-southeast-1.amazonaws.com
       UserPoolId                ap-southeast-1_XXXXXXXXX
       UserPoolClientId          <32-char-hex>
       HostedUiUrl               https://simple-bff-dev.auth.ap-southeast-1.amazoncognito.com
       CallbackUrl               http://localhost:3000/
       EntitiesTableName         simple-bff-dev-entities
       EntitiesTableStreamArn    arn:aws:dynamodb:...:table/simple-bff-dev-entities/stream/2026-...
       ListenerQueueUrl          https://sqs.ap-southeast-1.amazonaws.com/.../simple-bff-dev-listener
       TriggerFunctionName       simple-bff-dev-trigger

Get a JWT and call the API
--------------------------

1. Open HostedUiUrl in a browser. You can sign up with a new email and
   password, then sign in.
2. In the AWS console, go to Cognito → User Pools → your pool → Users,
   and confirm the new user (Hosted UI signup is unconfirmed by default
   in this minimal template, no SES configured).
3. The Hosted UI redirects back to CallbackUrl with ?code=... in the
   query string. Exchange that code for tokens:

       curl -X POST \
         https://simple-bff-dev.auth.ap-southeast-1.amazoncognito.com/oauth2/token \
         -H 'content-type: application/x-www-form-urlencoded' \
         --data-urlencode 'grant_type=authorization_code' \
         --data-urlencode 'client_id=<UserPoolClientId>' \
         --data-urlencode 'code=<code-from-redirect>' \
         --data-urlencode 'redirect_uri=http://localhost:3000/'

4. Use the id_token from the response to call the API:

       curl https://<HttpApiUrl>/hello \
         -H "authorization: Bearer <id_token>"

Expected response:

       {
         "message": "Hello from a v4 Serverless BFF",
         "stage": "dev",
         "user": { "sub": "...", "email": "...", "username": "..." },
         "path": "/hello",
         "method": "GET"
       }

Notes on what is and is not included
------------------------------------

This is intentionally minimal. It does not include:

  - Custom domain on the HTTP API
  - SES configuration for real email delivery on signup
  - MFA, advanced security mode, lambda triggers
  - Multiple services or shared layers
  - Tests (the focus here is a deployable v4 scaffold)

If you want any of those, that is the next conversation.

Why Cognito in the same stack and not a separate stack
-------------------------------------------------------

The book's template-bff-service splits Cognito into its own CloudFormation
stack. That is the right call when multiple services share one User Pool.
For a single service it adds a deploy dependency that is not pulling its
weight. This template keeps everything in one stack so deploy is one
command.