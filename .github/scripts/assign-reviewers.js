const { minimatch } = require('minimatch');
const fs = require('fs').promises;
const path = require('path');

module.exports = async ({github, context, core}) => {
  try {
    // 설정 파일 읽기
    const configPath = path.join('.github', 'reviewers-config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    
    // 설정 검증
    if (!config.minReviewers) {
      core.warning('minReviewers not defined in config, defaulting to 2');
      config.minReviewers = 2;
    }
    if (!config.maxReviewers) {
      core.warning('maxReviewers not defined in config, defaulting to 3');
      config.maxReviewers = 3;
    }

    const { owner, repo } = context.repo;
    const prNumber = context.payload.pull_request.number;
    const prAuthor = context.payload.pull_request.user.login;
    const baseSha = context.payload.pull_request.base.sha;

    core.info(`Processing PR #${prNumber} by ${prAuthor}`);
    core.info(`Config: min=${config.minReviewers}, max=${config.maxReviewers}`);

    // PR에서 변경된 파일 목록 가져오기
    const { data: files } = await github.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber
    });

    let reviewers = new Set();

    // 1단계: 도메인별 지정된 리뷰어 확인
    for (const file of files) {
      const domainReviewers = getCodeOwners(file.filename, config.codeOwners);
      domainReviewers.forEach(r => reviewers.add(r));
    }

    core.info(`Domain-based reviewers: ${Array.from(reviewers).join(', ') || 'none'}`);

    // 2단계: 리뷰어가 없으면 Git blame으로 최근 수정자 찾기
    if (reviewers.size < config.minReviewers) {
      for (const file of files) {
        if (file.status === 'modified' && reviewers.size < config.maxReviewers) {
          const blameReviewers = await getBlameReviewers(
            github, owner, repo, file.filename, baseSha, prAuthor, core
          );
          blameReviewers.forEach(r => reviewers.add(r));
        }
      }
      core.info(`After blame analysis: ${Array.from(reviewers).join(', ') || 'none'}`);
    }

    // 3단계: 여전히 최소 리뷰어 수에 못 미치면 기본 리뷰어 추가
    if (reviewers.size < config.minReviewers && config.defaultReviewers) {
      const needed = config.minReviewers - reviewers.size;
      const defaults = config.defaultReviewers.slice(0, needed);
      defaults.forEach(r => reviewers.add(r));
      core.info(`Added default reviewers: ${defaults.join(', ')}`);
    }

    // PR 작성자 제외
    if (config.excludeAuthors) {
      reviewers.delete(prAuthor);
    }

    // 시간대 필터링
    if (config.timezone?.enabled) {
      reviewers = await filterByTimezone(reviewers, config.timezone, core);
    }

    // 권한 있는 사용자만 필터링
    reviewers = await filterValidReviewers(
      github, context, Array.from(reviewers), core
    );

    // 최대 리뷰어 수 제한
    const finalReviewers = reviewers.slice(0, config.maxReviewers);

    // 리뷰어 지정
    if (finalReviewers.length > 0) {
      await github.rest.pulls.requestReviewers({
        owner,
        repo,
        pull_number: prNumber,
        reviewers: finalReviewers
      });

      core.info(`✅ Successfully assigned reviewers: ${finalReviewers.join(', ')}`);
      
      // PR에 코멘트 추가 (선택사항)
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `🔍 Auto-assigned reviewers: ${finalReviewers.map(r => `@${r}`).join(', ')}\n\nReviewers were selected based on code ownership and recent contributions.`
      });
    } else {
      core.warning('⚠️ No suitable reviewers found');
    }

  } catch (error) {
    core.error(`Error in reviewer assignment: ${error.message}`);
    core.setFailed(error.message);
  }
};

// 도메인별 코드 오너 찾기
function getCodeOwners(filename, codeOwners) {
  const reviewers = [];
  
  for (const [pattern, owners] of Object.entries(codeOwners)) {
    // 파일 패턴 매칭
    if (pattern.includes('*')) {
      if (minimatch(filename, pattern)) {
        reviewers.push(...owners);
      }
    } 
    // 디렉토리 매칭
    else if (pattern.endsWith('/')) {
      if (filename.startsWith(pattern)) {
        reviewers.push(...owners);
      }
    }
    // 정확한 파일명 매칭
    else if (filename === pattern) {
      reviewers.push(...owners);
    }
  }
  
  return [...new Set(reviewers)]; // 중복 제거
}

// Git blame으로 최근 수정자 찾기 (GraphQL 사용)
async function getBlameReviewers(github, owner, repo, filepath, baseSha, prAuthor, core) {
  const reviewers = new Set();
  
  try {
    // GraphQL 쿼리로 Git blame 정보 가져오기
    const blameQuery = `
      query($owner: String!, $repo: String!, $path: String!, $ref: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $ref) {
            ... on Commit {
              blame(path: $path) {
                ranges {
                  commit {
                    authoredDate
                    author {
                      user {
                        login
                      }
                    }
                  }
                  startingLine
                  endingLine
                  age
                }
              }
            }
          }
        }
      }
    `;

    core.info(`Getting blame for ${filepath} at ${baseSha}`);
    
    const blameData = await github.graphql(blameQuery, {
      owner,
      repo,
      path: filepath,
      ref: baseSha
    });
    console.log("blameData: ", blameData);

    if (blameData?.repository?.object?.blame?.ranges) {
      // 최근 커밋 순으로 정렬 (age가 낮을수록 최근)
      const ranges = blameData.repository.object.blame.ranges
        .filter(range => range.commit.author.user?.login)
        .sort((a, b) => a.age - b.age);

      core.info(`Found ${ranges.length} blame ranges for ${filepath}`);

      // 최근 수정자 2명 추출
      for (const range of ranges) {
        const author = range.commit.author.user.login;
        if (author && author !== prAuthor) {
          reviewers.add(author);
          core.info(`Found recent contributor: ${author}`);
          if (reviewers.size >= 2) break;
        }
      }
    }
  } catch (error) {
    // 파일이 새로 생성된 경우나 blame을 가져올 수 없는 경우
    if (error.message.includes('path does not exist')) {
      core.info(`${filepath} is a new file, skipping blame`);
    } else {
      core.warning(`Could not get blame for ${filepath}: ${error.message}`);
    }
  }
  
  return Array.from(reviewers);
}

// 시간대별 필터링
async function filterByTimezone(reviewers, timezoneConfig, core) {
  const filtered = new Set();
  
  for (const reviewer of reviewers) {
    const userTz = timezoneConfig.userTimezones[reviewer];
    
    if (!userTz) {
      // 시간대 정보가 없으면 포함
      filtered.add(reviewer);
      continue;
    }
    
    try {
      // 사용자의 현지 시간 계산
      const now = new Date();
      const userTime = new Date(now.toLocaleString('en-US', { timeZone: userTz }));
      const userHour = userTime.getHours();
      
      // 근무 시간 확인
      if (userHour >= timezoneConfig.workingHours.start && 
          userHour < timezoneConfig.workingHours.end) {
        filtered.add(reviewer);
      } else {
        core.info(`Skipping ${reviewer} - outside working hours (${userHour}:00 in ${userTz})`);
      }
    } catch (error) {
      core.warning(`Invalid timezone for ${reviewer}: ${userTz}`);
      filtered.add(reviewer);
    }
  }
  
  return filtered;
}

// 권한 있는 리뷰어만 필터링 (개선된 버전)
async function filterValidReviewers(github, context, reviewers, core) {
  const validReviewers = [];
  const { owner, repo } = context.repo;
  
  // 리포지토리 소유자 타입 확인
  const isOrganization = context.payload.repository.owner.type === 'Organization';
  
  for (const reviewer of reviewers) {
    try {
      // Collaborator 권한 확인
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: reviewer
      });
      
      // write 권한 이상만 리뷰어 가능
      if (['write', 'maintain', 'admin'].includes(data.permission)) {
        validReviewers.push(reviewer);
        core.info(`✓ ${reviewer} has ${data.permission} permission`);
      } else {
        core.info(`✗ ${reviewer} only has ${data.permission} permission`);
      }
      
    } catch (error) {
      // 404 에러는 collaborator가 아님을 의미
      if (error.status === 404) {
        // Organization인 경우 멤버십 확인
        if (isOrganization) {
          try {
            await github.rest.orgs.checkMembershipForUser({
              org: owner,
              username: reviewer
            });
            
            // Organization 멤버지만 repo 권한이 없는 경우
            core.info(`✗ ${reviewer} is org member but not a collaborator`);
          } catch (orgError) {
            core.info(`✗ ${reviewer} is not in the organization`);
          }
        } else {
          core.info(`✗ ${reviewer} is not a collaborator`);
        }
      } else {
        core.warning(`Error checking ${reviewer}: ${error.message}`);
      }
    }
  }
  
  return validReviewers;
}