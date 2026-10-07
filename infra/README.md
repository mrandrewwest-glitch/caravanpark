# Deploying OnSite as a container (ap-southeast-2)

`onsite-container.yaml` creates: ECR repository, ECS Fargate service (one task, runs `server.js` plus the 5-minute jobs), HTTPS Application Load Balancer with a DNS-validated ACM certificate and Route 53 alias, the DynamoDB table (retained on stack delete), one Secrets Manager secret, and an SES sender identity.

**Not yet deployed or validated against real AWS** (the template was written without AWS access).

## Steps

1. Confirm your project's Region is ap-southeast-2 (AWS Settings > View all projects > Overview > Additional Info > Region).
2. Deploy with no running task yet (the repository is empty):
   ```
   aws cloudformation deploy --region ap-southeast-2 --stack-name onsite \
     --template-file infra/onsite-container.yaml --capabilities CAPABILITY_IAM \
     --parameter-overrides DomainName=calls.example.com HostedZoneId=Z123... VpcId=vpc-... \
       PublicSubnetIds=subnet-a,subnet-b PortalFromEmail=portal@example.com DesiredCount=0
   ```
   The certificate validates through the hosted zone; the stack waits for it.
3. Click the SES verification link sent to `PortalFromEmail`. New SES accounts are in the sandbox: portal codes only reach verified addresses until you request production access.
4. Put the real keys in the secret (never in git or template parameters). CloudFormation already generated `admin_token` in it; `put-secret-value` replaces the whole secret, so keep that key:
   ```
   TOKEN=$(aws secretsmanager get-secret-value --region ap-southeast-2 --secret-id onsite/prod --query SecretString --output text | jq -r .admin_token)
   aws secretsmanager put-secret-value --region ap-southeast-2 --secret-id onsite/prod --secret-string \
     "{\"anthropic_api_key\":\"sk-ant-...\",\"account_sid\":\"AC...\",\"auth_token\":\"...\",\"api_key_sid\":\"SK...\",\"api_key_secret\":\"...\",\"admin_token\":\"$TOKEN\"}"
   ```
5. Build and push the image, then start the task:
   ```
   aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-southeast-2.amazonaws.com
   docker build -t <account>.dkr.ecr.ap-southeast-2.amazonaws.com/onsite:latest .
   docker push <account>.dkr.ecr.ap-southeast-2.amazonaws.com/onsite:latest
   aws cloudformation deploy ... DesiredCount=1   # same command as step 2
   ```
   Per-park config (`parks.json`, see `parks.example.json`) is baked into the image: create it before building (it contains references to secrets, never the secrets).
6. In Twilio, point each number's "A call comes in" at the `TwilioVoiceWebhook` output and "Call status changes" at `TwilioStatusWebhook`.

## Notes

- Run exactly one task (`DesiredCount` is capped at 1): it also runs hold-expiry/finalisation jobs. To scale out, set `RUN_JOBS=false` on the extra tasks.
- Tasks use public IPs (no NAT gateway, lower cost); the task security group admits only the ALB.
- `/admin/*` is enabled with a generated bearer token (`admin_token` in the secret, injected as `ADMIN_TOKEN`). Use it with `Authorization: Bearer <token>` to create portal users via `POST /admin/portal-users`. The ALB exposes `/admin/*` publicly, so treat the token like a password; rotate it by editing the secret and restarting the task.
- Delete the stack and the DynamoDB table stays (data kept); the secret and everything else are removed.
