# Deploying OnSite as a container (ap-southeast-2)

`onsite-container.yaml` creates: ECR repository (where the OnSite image is stored), ECS Fargate service (one task, runs `server.js` plus the 5-minute jobs), HTTPS Application Load Balancer with an ACM certificate, the DynamoDB table (retained on stack delete), one Secrets Manager secret, and an SES sender identity.

DNS is at GoDaddy (domain `papilots.co`), so two records are added there by hand. Address used: `onsite.papilots.co`.

**Not yet deployed or validated against real AWS** (the template was written without AWS access).

## Steps (run in AWS CloudShell, Sydney region)

1. **Region:** confirmed ap-southeast-2. Open CloudShell from the AWS Console and check the region selector says Asia Pacific (Sydney).
2. **Get the files:** `git clone https://github.com/mrandrewwest-glitch/caravanpark.git && cd caravanpark && git checkout claude/eloquent-pascal-djx1c4`
3. **Find a VPC and two subnets:** `aws ec2 describe-subnets --region ap-southeast-2 --filters Name=default-for-az,Values=true --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone]' --output table`
4. **Deploy with no running task yet** (the image repository is empty):
   ```
   aws cloudformation deploy --region ap-southeast-2 --stack-name onsite \
     --template-file infra/onsite-container.yaml --capabilities CAPABILITY_IAM \
     --parameter-overrides DomainName=onsite.papilots.co VpcId=vpc-... \
       PublicSubnetIds=subnet-a,subnet-b PortalFromEmail=you@yourdomain DesiredCount=0
   ```
5. **While step 4 is waiting** (it pauses on the certificate): AWS Certificate Manager console > the certificate for `onsite.papilots.co` shows a CNAME name and value. Add that CNAME at GoDaddy (DNS > Add record; GoDaddy appends `.papilots.co` itself, so remove it from the name AWS shows). The stack continues within minutes.
6. **SES:** click the verification link sent to `PortalFromEmail`. New SES accounts are in the sandbox: portal codes only reach verified addresses until you request production access.
7. **Point the domain at the load balancer:** read the `LoadBalancerDnsName` output (`aws cloudformation describe-stacks --stack-name onsite --query 'Stacks[0].Outputs'`), then at GoDaddy add a CNAME: name `onsite`, value that DNS name.
8. **Put the real keys in the secret** (never in git or parameters). CloudFormation already generated `admin_token` in it and `put-secret-value` replaces the whole secret, so keep that key:
   ```
   TOKEN=$(aws secretsmanager get-secret-value --region ap-southeast-2 --secret-id onsite/prod --query SecretString --output text | jq -r .admin_token)
   aws secretsmanager put-secret-value --region ap-southeast-2 --secret-id onsite/prod --secret-string \
     "{\"anthropic_api_key\":\"sk-ant-...\",\"account_sid\":\"AC...\",\"auth_token\":\"...\",\"api_key_sid\":\"SK...\",\"api_key_secret\":\"...\",\"admin_token\":\"$TOKEN\"}"
   ```
9. **Build and push the image, then start the task** (CloudShell has Docker):
   ```
   aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-southeast-2.amazonaws.com
   docker build -t <account>.dkr.ecr.ap-southeast-2.amazonaws.com/onsite:latest .
   docker push <account>.dkr.ecr.ap-southeast-2.amazonaws.com/onsite:latest
   ```
   then re-run the step 4 command with `DesiredCount=1`. Per-park config (`parks.json`, see `parks.example.json`) is baked into the image: create it before building (it holds references to secrets, never the secrets).
10. **Twilio:** point each number's "A call comes in" at `https://onsite.papilots.co/twilio/voice` and "Call status changes" at `https://onsite.papilots.co/twilio/status`.

## Notes

- Run exactly one task (`DesiredCount` is capped at 1): it also runs hold-expiry/finalisation jobs. To scale out, set `RUN_JOBS=false` on the extra tasks.
- Tasks use public IPs (no NAT gateway, lower cost); the task security group admits only the ALB.
- `/admin/*` is enabled with a generated bearer token (`admin_token` in the secret, injected as `ADMIN_TOKEN`). Use it with `Authorization: Bearer <token>` to create portal users via `POST /admin/portal-users`. The ALB exposes `/admin/*` publicly, so treat the token like a password; rotate it by editing the secret and restarting the task.
- Delete the stack and the DynamoDB table stays (data kept); the secret and everything else are removed.
