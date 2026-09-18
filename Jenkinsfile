pipeline {
  agent any
  triggers {
    githubPush()
    pollSCM('H H * * *')
  }
  environment {
    MAIL_RECIPIENTS = 'dev+tests-reports@wazo.community'
  }
  options {
    disableConcurrentBuilds()
    skipStagesAfterUnstable()
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '10'))
  }
  stages {
    stage('Docker build') {
      parallel {
        stage('Build amd64') {
          agent {
            label 'general-debian12-small'
          }
          steps {
            withCredentials([usernamePassword(
              credentialsId: 'docker-wazocommunity-user-password',
              passwordVariable: 'DOCKER_PASSWORD',
              usernameVariable: 'DOCKER_USERNAME'
            )]) {
              sh 'echo "${DOCKER_PASSWORD}" | docker login --username "${DOCKER_USERNAME}" --password-stdin'
              sh "docker build --pull -t wazoplatform/${JOB_NAME}:latest-amd64 ."
              sh "docker push wazoplatform/${JOB_NAME}:latest-amd64"
            }
          }
        }
        stage('Build arm64') {
          agent {
            label 'general-aws-arm-debian12-small'
          }
          steps {
            withCredentials([usernamePassword(
              credentialsId: 'docker-wazocommunity-user-password',
              passwordVariable: 'DOCKER_PASSWORD',
              usernameVariable: 'DOCKER_USERNAME'
            )]) {
              sh 'echo "${DOCKER_PASSWORD}" | docker login --username "${DOCKER_USERNAME}" --password-stdin'
              sh "docker build --pull -t wazoplatform/${JOB_NAME}:latest-arm64 ."
              sh "docker push wazoplatform/${JOB_NAME}:latest-arm64"
            }
          }
        }
      }
    }
    stage('Create manifest') {
      steps {
        withCredentials([usernamePassword(
          credentialsId: 'docker-wazocommunity-user-password',
          passwordVariable: 'DOCKER_PASSWORD',
          usernameVariable: 'DOCKER_USERNAME'
        )]) {
          sh 'echo "${DOCKER_PASSWORD}" | docker login --username "${DOCKER_USERNAME}" --password-stdin'
          // Assemble the multi-arch manifest from the per-arch images.
          sh """
            docker buildx imagetools create \
              -t wazoplatform/${JOB_NAME}:latest \
              wazoplatform/${JOB_NAME}:latest-amd64 \
              wazoplatform/${JOB_NAME}:latest-arm64
          """
        }
      }
    }
  }
  post {
    failure {
      emailext to: "${MAIL_RECIPIENTS}", subject: '${DEFAULT_SUBJECT}', body: '${DEFAULT_CONTENT}'
    }
    fixed {
      emailext to: "${MAIL_RECIPIENTS}", subject: '${DEFAULT_SUBJECT}', body: '${DEFAULT_CONTENT}'
    }
  }
}
