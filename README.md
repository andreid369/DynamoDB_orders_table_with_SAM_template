# Orders Service (AWS SAM)

A serverless application that saves orders to a multi-Region DynamoDB table behind an authenticated, rate-limited REST API. Everything is defined as code in one AWS SAM template and deployed from GitHub Actions or the SAM CLI.

## Project scope

**In scope**

- An authenticated, rate-limited REST API to save and read orders: `POST /orders` (through Lambda) and `GET /orders/{orderId}` (direct API Gateway to DynamoDB integration, no Lambda).
- Orders stored in a DynamoDB global table (on-demand capacity, Streams enabled) with a replica in a second Region.
- Observability with a CloudWatch dashboard, logs and X-Ray tracing.
- Infrastructure as code (`template.yaml`) with automatic deployment on every push to `main`.
- Free-tier and cost notes, and a complete tear-down procedure that keeps the configuration in Git.

**Out of scope**

- Automatic API failover. Only the data is multi-Region; the API, Lambda and Cognito user pool exist in the primary Region only.
- Migrating data from an earlier single-Region `Orders` table (the update replaces that table).
- Update, delete and list-all endpoints, pagination, and a front end.
- Production hardening such as a custom domain, CloudWatch alarms, point-in-time recovery and a resource-scoped deployment policy.

## Services

| Component | Details |
|-----------|---------|
| **DynamoDB global table** | Partition key `orderId`, sort key `itemId`, on-demand capacity, DynamoDB Streams enabled, replica in a secondary Region |
| **Lambda (writer)** | Node.js 22, bundled with esbuild (a few KB), SDK client created outside the handler, X-Ray tracing enabled |
| **API Gateway (REST)** | `POST /orders` calls the Lambda; `GET /orders/{orderId}` calls DynamoDB directly, with no Lambda |
| **Cognito** | User pool and app client; the user pool is the API's authorizer for both methods |
| **WAF** | Web ACL with a rate-based rule (default 100 requests per 5 minutes per IP) attached to the API stage |
| **CloudWatch** | Dashboard with API Gateway `Count`, `4XXError` and Lambda `Invocations`, `Errors` |
| **IAM** | Lambda role (`dynamodb:PutItem`, one table) and API Gateway role (`dynamodb:Query`, one table), both created by the template |
| **CloudFormation** | The SAM template is deployed as the stack `orders-service`, which creates every resource above |
| **CI/CD** | GitHub Actions workflow deploys on every push to `main` |

## Architecture

![Orders Service architecture: a client calls Amazon API Gateway, protected by AWS WAF and Amazon Cognito. POST requests go through AWS Lambda to an Amazon DynamoDB global table; GET requests query DynamoDB directly. The table replicates to a second Region. CloudWatch and X-Ray observe the stack, which GitHub Actions deploys with CloudFormation.](docs/architecture.svg)

Diagram drawn with the [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/). How a request flows:

1. The client signs in with Amazon Cognito and sends the ID token (JWT) with every request to Amazon API Gateway.
2. AWS WAF rate-limits each client IP, and the Cognito authorizer validates the token before the request reaches any backend.
3. `POST /orders` invokes the Lambda function, which writes the item to DynamoDB (`PutItem`).
4. `GET /orders/{orderId}` is answered by API Gateway itself: mapping templates turn the request into a DynamoDB `Query` and the response back into plain JSON, with no Lambda involved.
5. The DynamoDB global table replicates every write to the replica Region through DynamoDB Streams.
6. API Gateway and Lambda metrics and logs go to CloudWatch; Lambda traces go to X-Ray.
7. A push to `main` starts GitHub Actions, which runs `sam build` and `sam deploy`; CloudFormation creates or updates every resource.

## Project structure

```
.
├── .github/
│   ├── dependabot.yml
│   └── workflows/
│       └── deploy.yml
├── docs/
│   └── architecture.svg
├── src/
│   ├── app.mjs
│   ├── package.json
│   └── package-lock.json
├── .gitignore
├── template.yaml
└── README.md
```

## Prerequisites

| Tool | Purpose | Check |
|------|---------|-------|
| AWS account | Where the stack is deployed | |
| AWS CLI | Credentials and general AWS access | `aws --version` |
| AWS SAM CLI | Build and deploy (separate from the AWS CLI) | `sam --version` |
| Node.js 22 and npm | `sam build` runs `npm` and esbuild | `node --version` |
| Git | Version control | `git --version` |
| GitHub account | Repository and Actions | |

Configure AWS credentials once:

```bash
aws configure
aws sts get-caller-identity   # confirms which account you are using
```

---

## How it works

### Lambda optimisation

- **Small package.** `template.yaml` tells `sam build` to bundle `src/app.mjs` with esbuild (minified, ES2022, no source map). The AWS SDK v3 is marked `External` because the Node.js 22 runtime already includes it, so the deployed package contains only your code (a few KB instead of megabytes). `src/package.json` only lists esbuild as a dev dependency, so nothing else is installed into the package.
- **Initialisation outside the handler.** The table name is read once, the `DynamoDBClient` and `DynamoDBDocumentClient` are created once at module load, and constants such as the response headers are defined once. All of this runs on a cold start only; warm invocations reuse it. The handler contains only per-request work. SDK v3 keeps HTTPS connections alive by default, so no extra connection-reuse setting is needed. If `TABLE_NAME` is missing, the cold start fails immediately instead of failing every request.
- **Input validation.** `orderId` and `itemId` must be non-empty strings (a wrong type is rejected with `400` instead of causing a DynamoDB error), and `createdAt` is always set by the server.
- **Reproducible builds.** `src/package-lock.json` is committed, so every `sam build` installs the same esbuild version. Dependabot keeps it up to date (see Part 3).

### Direct API Gateway to DynamoDB integration (no Lambda)

`GET /orders/{orderId}` is defined in the API's OpenAPI body in `template.yaml` as an AWS service integration:

- API Gateway assumes `ApiDynamoDbReadRole`, which is allowed only `dynamodb:Query` on this one table.
- **Request mapping template** turns the path parameter into a DynamoDB `Query` request (`orderId = :orderId`). The value is escaped so a hostile `orderId` cannot change the query.
- **Response mapping template** converts DynamoDB's typed JSON (`{"qty":{"N":"2"}}`) into plain JSON (`{"qty":2}`).
- Error mapping: any DynamoDB `4xx` becomes `400 {"message":"Bad request"}` and any `5xx` becomes `500 {"message":"Internal error"}`.
- The Cognito authorizer and the WAF rate limit apply to this method too.

Example response:

```json
{
  "orderId": "o-1",
  "count": 2,
  "items": [
    { "orderId": "o-1", "itemId": "i-1", "qty": 2, "price": 19.9, "createdAt": "2026-10-14T10:00:00.000Z" },
    { "orderId": "o-1", "itemId": "i-2", "qty": 1, "createdAt": "2026-10-14T10:00:05.000Z" }
  ]
}
```

Limits of this approach:

- The mapping template converts string (`S`), number (`N`) and boolean (`BOOL`) attributes. Lists, maps and sets come back as `null`; extend the template if you store them.
- A `Query` returns at most 1 MB per call and the template does not paginate. This is plenty for the items of one order.
- An unknown `orderId` returns `200` with `"count": 0` and an empty list, not `404`.

### Global table and disaster recovery

The table is an `AWS::DynamoDB::GlobalTable` with DynamoDB Streams enabled (`NEW_AND_OLD_IMAGES`, required by global tables) and two replicas: the stack's own Region and `ReplicaRegion` (default `eu-west-1`). Every write is replicated to the other Region, usually within about a second. The replica Region must differ from the stack's Region.

What this gives you: a second, up-to-date copy of your data in another Region, and the ability to read and write the table there if the primary Region has problems.

What it does not give you: automatic API failover. The API, Lambda and Cognito pool live in the primary Region only. For full multi-Region availability you would also deploy the API and Lambda in the replica Region and add Route 53 failover, which this project does not do.

Point-in-time recovery is not enabled, to avoid its storage charge. Add this under `Replicas` if you want it:

```yaml
        - Region: !Ref AWS::Region
          PointInTimeRecoverySpecification:
            PointInTimeRecoveryEnabled: true
```

#### Important: replacing the old table

CloudFormation cannot convert an `AWS::DynamoDB::Table` into a global table in place. The template therefore replaces the old `OrdersTable` with a new `OrdersGlobalTable` (and no longer sets a fixed `TableName`, because the old table `Orders` would clash). If you deployed the previous version of this project:

1. **Existing data is not copied.** The old table is deleted by the update. Export anything you need first:

   ```bash
   aws dynamodb scan --table-name Orders --region eu-central-1 > orders-backup.json
   ```

2. The new table has a generated name, shown in the stack output `OrdersTableName`. The Lambda function and the API role use it automatically.
3. Update the deployment IAM user's policy first (see Part 3), otherwise creating the replica fails.

---

## Free tier and costs

Everything in this project deploys on an AWS free tier / Free Plan account, but not everything is free.

| Item | Cost |
|------|------|
| **AWS WAF** | Not free. Roughly $6/month while the stack exists (web ACL plus one rule, plus a small per-request charge); verify on the AWS pricing page. This is the main fixed cost. |
| **DynamoDB** | Always-free allowances: 25 GB storage per Region and 2.5 million Streams read requests per month. The free read/write capacity units (including the 25 replicated write units for global tables) apply to provisioned capacity, not to this on-demand table, so requests are billed per million at tiny rates; a few test requests cost a fraction of a cent. Replicated writes cost more than normal writes and the replica stores its own copy of the data. There is no hourly charge for the replica. |
| **DynamoDB Streams** | Enabling Streams is free; the first 2.5 million Streams read requests per month are included. Nothing in this project reads the stream itself. |
| **Lambda, Cognito, X-Ray, CloudWatch dashboard** | Within the free allowances at test volumes. |
| **API Gateway (REST)** | Free allowance depends on your account type (older accounts: a free calls allowance for 12 months). The direct DynamoDB integration costs the same as any other REST API call. |
| **Point-in-time recovery** | Not enabled (it is billed per GB). |

New accounts on the Free Plan can use their AWS credits for these charges. To stop all charges, follow [Part 4](#part-4-tear-down-and-stop-all-costs-keep-the-configuration) and delete the stack (this also deletes the replica) when you are not testing. The configuration stays in Git, so you can redeploy at any time.

---

## Part 1: Upload the project to GitHub

### 1. Add a `.gitignore`

```
.aws-sam/
node_modules/
.env
env.json
*.log
.DS_Store
```

`.aws-sam/` contains build output and should never be committed. Never commit AWS keys.

### 2. Initialise the repository

```bash
git init -b main
git add .
git commit -m "Initial commit: Orders API"
```

### 3. Create the GitHub repository

**Option A: GitHub CLI**

```bash
gh auth login
gh repo create orders-service --private --source=. --remote=origin --push
```

**Option B: GitHub website**

1. Go to https://github.com/new, name the repository and choose Private or Public.
2. Do **not** add a README or `.gitignore` there (you already have them).
3. Run the commands GitHub shows:

```bash
git remote add origin https://github.com/<your-username>/orders-service.git
git push -u origin main
```

If GitHub asks for a password, use a Personal Access Token or SSH keys; account passwords are not accepted for Git operations.

> **Before you push the workflow:** the pipeline needs AWS credentials in GitHub secrets (Part 3). Without them, the first run fails at the "Configure AWS credentials" step. That is harmless, but you may prefer to complete Part 3 first.

---

## Part 2: Deploy manually with the SAM CLI

```bash
sam validate --lint
sam build
sam deploy --guided
```

Suggested answers for `--guided`:

| Prompt | Value |
|--------|-------|
| Stack Name | `orders-service` (use the same name as `STACK_NAME` in the workflow) |
| AWS Region | for example `eu-central-1` |
| Parameter ReplicaRegion | for example `eu-west-1` (must differ from the stack Region) |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| Disable rollback | `n` |
| Save arguments to configuration file | `y` |

Creating the replica makes the first deployment take a few minutes longer. Later deployments: `sam build && sam deploy`.

`sam build` prints something like `Running NodejsNpmEsbuildBuilder`. To see the size reduction, run `ls -l .aws-sam/build/SaveOrderFunction/`: it should contain a single `app.mjs` of a few KB.

### Test the deployed API

The API is protected by Cognito, so you need a token first. Get the IDs from the stack outputs:

```bash
aws cloudformation describe-stacks --stack-name orders-service \
  --query "Stacks[0].Outputs" --output table
```

Create a user and sign in:

```bash
# Create the user
aws cognito-idp sign-up --client-id <UserPoolClientId> \
  --username you@example.com --password 'Str0ng!Passw0rd'

# Confirm without email verification (test only)
aws cognito-idp admin-confirm-sign-up --user-pool-id <UserPoolId> \
  --username you@example.com

# Get an ID token
TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
  --client-id <UserPoolClientId> \
  --auth-parameters USERNAME=you@example.com,PASSWORD='Str0ng!Passw0rd' \
  --query AuthenticationResult.IdToken --output text)
```

**Save an order item (Lambda):**

```bash
curl -X POST "<SaveOrderApiUrl>" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"o-1","itemId":"i-1","qty":2,"price":19.9}'
```

**Read an order (direct DynamoDB integration):** use `GetOrderApiUrl` and replace `ORDER_ID`:

```bash
curl -H "Authorization: $TOKEN" \
  "https://<api-id>.execute-api.<region>.amazonaws.com/Prod/orders/o-1"
```

| Result | Meaning |
|--------|---------|
| `201` (POST) | Order item saved |
| `409` (POST) | That `orderId` + `itemId` already exists |
| `400` (POST) | Invalid JSON, or `orderId`/`itemId` missing or not a string |
| `200` (GET) | Items of the order (empty list if none) |
| `400`/`500` (GET) | DynamoDB rejected the request (see Troubleshooting) |
| `401` | Missing or invalid token |
| `403` | Blocked by WAF (rate limit exceeded) |

### Check replication

```bash
TABLE=$(aws cloudformation describe-stacks --stack-name orders-service \
  --region eu-central-1 \
  --query "Stacks[0].Outputs[?OutputKey=='OrdersTableName'].OutputValue" --output text)

# Replica status (each replica should be ACTIVE)
aws dynamodb describe-table --table-name "$TABLE" --region eu-central-1 \
  --query "Table.{Status:TableStatus,Replicas:Replicas[].{Region:RegionName,Status:ReplicaStatus},Stream:StreamSpecification}"

# The item you saved through the API should be readable in the replica Region
aws dynamodb query --table-name "$TABLE" --region eu-west-1 \
  --key-condition-expression "orderId = :o" \
  --expression-attribute-values '{":o":{"S":"o-1"}}'
```

### Monitoring

- **Dashboard:** open the `DashboardUrl` stack output (CloudWatch dashboard `<stack-name>-orders`). The Lambda widget only counts POST requests; GET requests appear only in the API Gateway widget because they never invoke Lambda.
- **Logs:** `sam logs --stack-name orders-service --name SaveOrderFunction --tail`
- **Traces:** CloudWatch console > X-Ray traces (or Application Signals > Traces).
- **WAF:** blocked requests appear under the `BlockedRequests` metric (namespace `AWS/WAFV2`) and in the web ACL's sampled requests.

### Test the rate limit

Set the `RateLimit` parameter low and redeploy:

```bash
sam deploy --parameter-overrides RateLimit=10
```

Then send a burst of requests. WAF evaluates the counts with a short delay, so blocking may begin after a brief lag. Remember to set the value back afterwards.

### Delete everything

```bash
sam delete --stack-name orders-service
```

See [Part 4](#part-4-tear-down-and-stop-all-costs-keep-the-configuration) for the complete tear-down checklist, including the replica Region and leftovers that `sam delete` does not remove.

---

## Part 3: Automatic deployment with GitHub Actions

The workflow in `.github/workflows/deploy.yml` runs on every push to `main` (and can be started manually from the Actions tab). It:

1. Checks out the code and installs Python, Node.js 22, esbuild and the SAM CLI.
2. Configures AWS credentials from GitHub repository secrets.
3. Checks that `REPLICA_REGION` differs from `AWS_REGION`.
4. Runs `sam validate --lint`.
5. Runs `sam build`, which bundles the Lambda code from `src/` with esbuild.
6. Runs `sam deploy`, which uploads the package to the SAM-managed S3 bucket and updates the stack, including the function code.
7. Prints the Lambda function's last-modified time and code hash, and lists the stack outputs in the job summary.

Only one deployment runs at a time; a newer push waits for the running one to finish.

### 1. Create a dedicated IAM user for deployments

Do not use your personal or root credentials. Save the following as `deploy-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "s3:*",
        "lambda:*",
        "apigateway:*",
        "dynamodb:*",
        "cognito-idp:*",
        "wafv2:*",
        "cloudwatch:*",
        "logs:*",
        "xray:*",
        "application-autoscaling:*",
        "iam:CreateServiceLinkedRole",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy"
      ],
      "Resource": "*"
    }
  ]
}
```

Two entries exist for global tables: `iam:CreateServiceLinkedRole` lets DynamoDB create the service-linked role it uses for replication, and `application-autoscaling:*` is used by CloudFormation when it creates and deletes a global table (even an on-demand one). **If you created the user with an earlier version of this policy, update it now:**

```bash
aws iam put-user-policy \
  --user-name github-actions-sam-deploy \
  --policy-name sam-deploy \
  --policy-document file://deploy-policy.json
```

This policy is scoped by service, not by resource. It is fine for a personal or sandbox account; tighten the `Resource` entries before using it for anything important. Because the user can create IAM roles, treat these keys as highly sensitive.

Create the user and its access key (first time only):

```bash
aws iam create-user --user-name github-actions-sam-deploy

aws iam put-user-policy \
  --user-name github-actions-sam-deploy \
  --policy-name sam-deploy \
  --policy-document file://deploy-policy.json

aws iam create-access-key --user-name github-actions-sam-deploy
```

The last command prints an `AccessKeyId` and a `SecretAccessKey`. The secret is shown only once, so copy it now. Do not save `deploy-policy.json` or the key output in the repository.

### 2. Add the keys as GitHub repository secrets

Repository > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**, or with the GitHub CLI:

```bash
gh secret set AWS_ACCESS_KEY_ID
gh secret set AWS_SECRET_ACCESS_KEY
```

(The CLI prompts you to paste each value.)

| Secret name | Value |
|-------------|-------|
| `AWS_ACCESS_KEY_ID` | Access key ID of the `github-actions-sam-deploy` user |
| `AWS_SECRET_ACCESS_KEY` | Matching secret access key |

### 3. Set the Regions and stack name

At the top of `.github/workflows/deploy.yml`:

```yaml
env:
  AWS_REGION: eu-central-1
  STACK_NAME: orders-service
  REPLICA_REGION: eu-west-1
```

If you already deployed manually in Part 2, keep `STACK_NAME` identical to that stack so the workflow updates it instead of trying to create a second one.

### 4. Commit and push

```bash
git add .
git commit -m "Optimise Lambda, add direct DynamoDB integration and global table"
git push
```

Open the repository's **Actions** tab to watch the run. When it finishes, the run's **Summary** page lists the API URLs, table name, user pool ID, client ID and dashboard URL.

### 5. Update the Lambda code

Edit `src/app.mjs` (or `template.yaml`), then:

```bash
git add .
git commit -m "Update order handler"
git push
```

The workflow rebuilds and redeploys. The "Show deployed Lambda function details" step shows the new `LastModified` and `CodeSha256` values, confirming the function code changed.

### Alternative: no long-lived keys (OIDC)

Stored access keys work, but they never expire unless you rotate them. If you want to avoid them, GitHub can assume an IAM role with short-lived credentials:

1. In IAM, add an identity provider: type OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Create a role trusted by that provider, restricted to your repo and branch (condition `token.actions.githubusercontent.com:sub` equal to `repo:<user>/<repo>:ref:refs/heads/main`), and attach the same permissions as above.
3. Save the role ARN as a secret named `AWS_ROLE_ARN`.
4. In the workflow, add this at the top level:

   ```yaml
   permissions:
     id-token: write
     contents: read
   ```

   and replace the credentials step with:

   ```yaml
   - uses: aws-actions/configure-aws-credentials@v4
     with:
       role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
       aws-region: ${{ env.AWS_REGION }}
   ```

### Dependency updates (Dependabot)

`.github/dependabot.yml` makes Dependabot open a pull request every week for outdated npm dependencies in `src/` (esbuild) and for outdated GitHub Actions versions used by the workflow. Merging one of these pull requests into `main` triggers a deployment, so review the build result before merging.

### Security tips

- Rotate the access key periodically (`aws iam create-access-key`, update the secrets, then delete the old key).
- Keep the repository private, or at least do not run deployment workflows on pull requests from forks. This workflow runs only on pushes to `main`.
- Protect the `main` branch so only reviewed changes can trigger a deployment.
- If a key is ever exposed, deactivate it in IAM immediately.

---

## Part 4: Tear down and stop all costs (keep the configuration)

Everything is defined in this repository (`template.yaml`, `src/`, the workflow and this README), so you can delete all AWS resources and recreate them later with a single deploy. The commands below assume primary Region `eu-central-1`, replica Region `eu-west-1` and stack name `orders-service`; replace them with your own values.

### 1. Stop the pipeline from redeploying

The next push to `main` would rebuild everything, so disable the workflow first:

```bash
gh workflow disable "Deploy SAM application"
```

Or use the Actions tab (workflow menu > **Disable workflow**). To redeploy later, run `gh workflow enable "Deploy SAM application"`, then push or start it manually.

### 2. Back up the data (optional)

Deleting the stack deletes the table, its replica and the Cognito users. For a small table, export the items to a local file:

```bash
TABLE=$(aws cloudformation describe-stacks --stack-name orders-service \
  --region eu-central-1 \
  --query "Stacks[0].Outputs[?OutputKey=='OrdersTableName'].OutputValue" --output text)

aws dynamodb scan --table-name "$TABLE" --region eu-central-1 > orders-backup.json
```

Avoid DynamoDB's built-in backups for this purpose: they outlive the table and keep billing for storage. Do not commit the backup file to the repository if it contains customer data.

### 3. Delete the stack

```bash
sam delete --stack-name orders-service --region eu-central-1
```

This removes the Lambda function, API Gateway, the global table including its replica, the Cognito user pool, the WAF web ACL (the main fixed cost), the CloudWatch dashboard, the IAM roles, and the build artifacts SAM uploaded to S3.

### 4. Remove leftovers that CloudFormation does not delete

| Leftover | Cost | How to remove |
|----------|------|---------------|
| Lambda log group | Storage of logs (kept forever by default) | See below |
| X-Ray traces | None to remove | They expire automatically after 30 days |
| SAM helper stack and S3 bucket (`aws-sam-cli-managed-default`) | Almost nothing once empty | See below |

Delete the log group:

```bash
aws logs describe-log-groups --region eu-central-1 \
  --log-group-name-prefix /aws/lambda/orders-service \
  --query "logGroups[].logGroupName" --output text

aws logs delete-log-group --region eu-central-1 \
  --log-group-name <name from the previous command>
```

Remove the SAM helper stack (optional). Empty the bucket in the S3 console first, because it is versioned, then:

```bash
aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default --region eu-central-1
```

Skip this if you plan to redeploy, since SAM reuses the bucket.

### 5. Secure the deployment credentials

The IAM user costs nothing, but its access keys remain valid while the GitHub secrets exist. Choose one:

```bash
# Keep the user for later, but disable the key
aws iam update-access-key --user-name github-actions-sam-deploy \
  --access-key-id <AccessKeyId> --status Inactive

# Or remove the user completely
aws iam delete-access-key --user-name github-actions-sam-deploy --access-key-id <AccessKeyId>
aws iam delete-user-policy --user-name github-actions-sam-deploy --policy-name sam-deploy
aws iam delete-user --user-name github-actions-sam-deploy
```

If you delete the user, also remove the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets under **Settings > Secrets and variables > Actions**.

### 6. Verify nothing is left

```bash
# Should report that the stack does not exist
aws cloudformation describe-stacks --stack-name orders-service --region eu-central-1

# Should be empty (no web ACLs means no WAF charges)
aws wafv2 list-web-acls --scope REGIONAL --region eu-central-1

# Should not list your orders table, in BOTH Regions
aws dynamodb list-tables --region eu-central-1
aws dynamodb list-tables --region eu-west-1
```

If the replica table is still listed in the replica Region, delete it there (`aws dynamodb delete-table --table-name <name> --region eu-west-1`).

In the AWS console, **Billing and Cost Management > Cost Explorer** shows whether charges have stopped; it can take a day to update. A monthly budget alert (Billing > Budgets) is a cheap safeguard against surprises.

### Redeploying later

1. Re-enable the workflow: `gh workflow enable "Deploy SAM application"`.
2. Make sure the IAM user, its access key and the two GitHub secrets exist (Part 3, steps 1 and 2).
3. Push to `main`, or run the workflow from the Actions tab (or `sam build && sam deploy` locally).

All resources are recreated from the template. The table will be empty and users must sign up again; restore the exported items if needed.

---

## Troubleshooting

| Problem | Likely cause and fix |
|---------|----------------------|
| Workflow fails at "Configure AWS credentials" | The `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secret is missing or misspelled. |
| `AccessDenied` during `sam deploy` | The IAM user lacks a permission. The error names the missing action; add it to the policy. |
| `not authorized to perform: iam:CreateServiceLinkedRole` | Add that action to the deployment policy (Part 3) and re-run. |
| `not authorized to perform: application-autoscaling:DeregisterScalableTarget` (or other `application-autoscaling:` actions) | Add `application-autoscaling:*` to the deployment policy (Part 3) and re-run. The stack rolls back safely to its previous state in the meantime. |
| Stack update fails creating the global table | The replica Region equals the stack Region, or is misspelled or not enabled for your account. Use a different, valid Region. |
| `Orders already exists` / stack in `ROLLBACK_COMPLETE` | A table with that name exists from an older stack, or `STACK_NAME` differs from your manual deploy. Use the same stack name, or delete the old table/stack. If a stack is stuck in `ROLLBACK_COMPLETE`, delete it and redeploy. |
| `Cannot find esbuild. esbuild must be installed on the host machine` | `src/package.json` is missing, in the wrong folder, or not committed (check with `git ls-files src/`). The workflow also installs esbuild globally as a safeguard; for local builds run `npm install --global esbuild@0.25` or fix `src/package.json`. |
| `sam build` fails in the esbuild step | Node.js/npm is missing or has no network access (esbuild is downloaded with `npm install`). Install Node.js 22, check `src/package.json` exists, and retry. |
| `Cannot find module 'app'` / handler not found in Lambda | The build must produce `app.mjs`. Check the `OutExtension` and `EntryPoints` lines under the function's `Metadata` and that the handler is `app.handler`. |
| `sam: command not found` locally | The SAM CLI is separate from the AWS CLI; install it separately. |
| `Requires capabilities : [CAPABILITY_IAM]` | Add `--capabilities CAPABILITY_IAM` (already set in the workflow). |
| `401 Unauthorized` from the API | Missing or expired token. Send the **ID token** in the `Authorization` header (tokens last 1 hour by default). |
| `403 Forbidden` from the API | WAF rate limit exceeded, or wrong path. Wait a few minutes and check the URL. |
| `GET` returns `{"message":"Bad request"}` | DynamoDB returned a 4xx. Typical causes: the API role lacks `dynamodb:Query` on the table, or the table name in the request mapping is wrong. Turn on API Gateway execution logging for the stage to see the DynamoDB error. |
| `GET` returns `{"message":"Internal error"}` | DynamoDB returned a 5xx or throttled. Retry; check the table in the console. |
| `GET` shows `null` for an attribute | That attribute is a list, map or set, which the response mapping does not convert. |
| Dashboard Lambda widget is empty after a `GET` | Expected: `GET /orders/{orderId}` does not invoke Lambda. |
| Dashboard widgets are empty | Metrics only appear after the API has received traffic; send a few requests and widen the time range. |
| `The parameter Limit must be at least 10` | WAF's rate-based rule minimum is 10; set `RateLimit` to 10 or higher. |
