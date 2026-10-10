# Orders Service (AWS SAM)

A serverless application that saves orders to DynamoDB behind an authenticated, rate-limited REST API.

| Component | Details |
|-----------|---------|
| **DynamoDB** | Table `Orders`, partition key `orderId`, sort key `itemId`, on-demand capacity |
| **Lambda** | Node.js 22 function that saves one order item per request, X-Ray tracing enabled |
| **API Gateway** | REST API, `POST /orders` on the `Prod` stage |
| **Cognito** | User pool and app client; the user pool is the API's authorizer |
| **WAF** | Web ACL with a rate-based rule (default 100 requests per 5 minutes per IP) attached to the API stage |
| **CloudWatch** | Dashboard with API Gateway `Count`, `4XXError` and Lambda `Invocations`, `Errors` |
| **IAM** | Lambda execution role created by SAM with `dynamodb:PutItem` on the table only |
| **CI/CD** | GitHub Actions workflow deploys on every push to `main` |

## Project structure

```
.
├── .github/
│   └── workflows/
│       └── deploy.yml
├── src/
│   └── app.mjs
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
| Git | Version control | `git --version` |
| GitHub account | Repository and Actions | |

Configure AWS credentials once:

```bash
aws configure
aws sts get-caller-identity   # confirms which account you are using
```

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
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| Disable rollback | `n` |
| Save arguments to configuration file | `y` |

Later deployments: `sam build && sam deploy`.

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

Call the API:

```bash
curl -X POST "<SaveOrderApiUrl>" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"o-1","itemId":"i-1","qty":2,"price":19.9}'
```

| Result | Meaning |
|--------|---------|
| `201` | Order item saved |
| `409` | That `orderId` + `itemId` already exists |
| `401` | Missing or invalid token |
| `403` | Blocked by WAF (rate limit exceeded) |

Check the data:

```bash
aws dynamodb query --table-name Orders \
  --key-condition-expression "orderId = :o" \
  --expression-attribute-values '{":o":{"S":"o-1"}}'
```

### Monitoring

- **Dashboard:** open the `DashboardUrl` stack output (CloudWatch dashboard `<stack-name>-orders`).
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

This deletes the `Orders` table and its data, the user pool and its users, and the web ACL (which stops its monthly charge).

---

## Part 3: Automatic deployment with GitHub Actions

The workflow in `.github/workflows/deploy.yml` runs on every push to `main` (and can be started manually from the Actions tab). It:

1. Checks out the code and installs Python, Node.js 22 and the SAM CLI.
2. Configures AWS credentials from GitHub repository secrets.
3. Runs `sam validate --lint`.
4. Runs `sam build`, which packages the Lambda code from `src/`.
5. Runs `sam deploy`, which uploads the package to the SAM-managed S3 bucket and updates the stack, including the function code.
6. Prints the Lambda function's last-modified time and code hash, and lists the stack outputs in the job summary.

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

This is scoped by service, not by resource. It is fine for a personal or sandbox account; tighten the `Resource` entries before using it for anything important. Because the user can create IAM roles, treat these keys as highly sensitive.

Create the user and its access key:

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

### 3. Set the region and stack name

At the top of `.github/workflows/deploy.yml`:

```yaml
env:
  AWS_REGION: eu-central-1
  STACK_NAME: orders-service
```

If you already deployed manually in Part 2, keep `STACK_NAME` identical to that stack so the workflow updates it instead of trying to create a second stack. A second stack would fail because the `Orders` table name is fixed.

### 4. Commit and push

```bash
git add .github/workflows/deploy.yml
git commit -m "Add GitHub Actions deployment"
git push
```

Open the repository's **Actions** tab to watch the run. When it finishes, the run's **Summary** page lists the API URL, user pool ID, client ID and dashboard URL.

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

### Security tips

- Rotate the access key periodically (`aws iam create-access-key`, update the secrets, then delete the old key).
- Keep the repository private, or at least do not run deployment workflows on pull requests from forks. This workflow runs only on pushes to `main`.
- Protect the `main` branch so only reviewed changes can trigger a deployment.
- If a key is ever exposed, deactivate it in IAM immediately.

---

## Cost notes (free tier)

Most services here have a free tier or free allowance (Lambda, DynamoDB on-demand for small usage, Cognito, X-Ray, CloudWatch dashboards within limits). **AWS WAF is not free**: expect a few dollars per month for the web ACL and its rule while the stack exists (about $6/month at published prices; verify on the AWS pricing page). New accounts on the Free Plan can use their credits for this. To stop WAF charges, delete the stack (`sam delete`) when you are not testing. API Gateway REST API free allowances depend on your account type; check the AWS Free Tier page for your account.

---

## Troubleshooting

| Problem | Likely cause and fix |
|---------|----------------------|
| Workflow fails at "Configure AWS credentials" | The `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secret is missing or misspelled. |
| `AccessDenied` during `sam deploy` | The IAM user lacks a permission. The error names the missing action; add it to the policy. |
| `Orders already exists` / stack in `ROLLBACK_COMPLETE` | A table named `Orders` exists from another stack, or `STACK_NAME` differs from your manual deploy. Use the same stack name, or delete the old table/stack. If a stack is stuck in `ROLLBACK_COMPLETE`, delete it and redeploy. |
| `sam: command not found` locally | The SAM CLI is separate from the AWS CLI; install it separately. |
| `Requires capabilities : [CAPABILITY_IAM]` | Add `--capabilities CAPABILITY_IAM` (already set in the workflow). |
| `401 Unauthorized` from the API | Missing or expired token. Send the **ID token** in the `Authorization` header (tokens last 1 hour by default). |
| `403 Forbidden` from the API | WAF rate limit exceeded, or wrong path. Wait a few minutes and check the path ends in `/Prod/orders`. |
| Dashboard widgets are empty | Metrics only appear after the API has received traffic; send a few requests and widen the time range. |
| `The parameter Limit must be at least 10` | WAF's rate-based rule minimum is 10; set `RateLimit` to 10 or higher. |
